import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMessages, parseMaybeJson } from './genai';
import { loadTraces } from './load';
import type { Trace } from './types';

const load = (name: string): Trace[] =>
  loadTraces(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'), name);

describe('buildTraces', () => {
  it('groups spans into traces and orders steps by start time with depth', () => {
    const traces = load('agent-runtime-kit.otlp.json');
    expect(traces).toHaveLength(2);
    const [refund] = traces;
    expect(refund!.title).toBe('invoke_agent support-bot');
    expect(refund!.serviceName).toBe('support-bot-demo');
    expect(refund!.steps.map((s) => [s.kind, s.depth])).toEqual([
      ['agent', 0],
      ['model', 1],
      ['tool', 1],
      ['tool', 1],
      ['model', 1],
    ]);
    expect(refund!.steps[0]!.offsetMs).toBe(0);
  });

  it('does not double count usage repeated on the agent span', () => {
    const [refund, status] = load('agent-runtime-kit.otlp.json');
    expect(refund!.totals).toMatchObject({ inputTokens: 5050, outputTokens: 108, cacheReadTokens: 4100, modelCalls: 2, toolCalls: 2 });
    expect(refund!.totals.costUsd).toBeUndefined();
    expect(status!.totals).toMatchObject({ inputTokens: 1910, outputTokens: 44, modelCalls: 2, toolCalls: 1 });
  });

  it('reads messages, tool arguments/results and cost from GenAI attributes', () => {
    const [trace] = load('refund-v1.otlp.json');
    const [, firstChat, lookup] = trace!.steps;
    expect(firstChat!.kind).toBe('model');
    expect(firstChat!.model).toBe('example-large-2026-09-01');
    expect(firstChat!.costUsd).toBeCloseTo(0.00324, 9);
    expect(firstChat!.systemInstructions?.[0]?.role).toBe('system');
    expect(firstChat!.inputMessages?.[0]?.parts[0]).toMatchObject({ type: 'text' });
    expect(firstChat!.outputMessages?.[0]?.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_call']);
    expect(firstChat!.finishReasons).toEqual(['tool_calls']);
    expect(lookup!.toolName).toBe('lookup_order');
    expect(lookup!.toolArguments).toEqual({ order_id: 'A-1001' });
    expect(lookup!.toolResult).toMatchObject({ status: 'delivered', amount: 42.5 });
    expect(lookup!.durationMs).toBeCloseTo(212, 3);
  });

  it('totals cost, latency and calls for a priced trace', () => {
    const [trace] = load('refund-v1.otlp.json');
    expect(trace!.totals.costUsd).toBeCloseTo(0.00594, 9); // matches otel-genai-cost's costreport
    expect(trace!.totals.pricedModelCalls).toBe(2);
    expect(trace!.totals.latencyMs).toBeCloseTo(5240, 3);
    expect(trace!.totals.errors).toBe(0);
  });

  it('surfaces failed tool calls', () => {
    const [trace] = load('refund-v2-timeout.otlp.json');
    const refund = trace!.steps.find((s) => s.toolName === 'issue_refund')!;
    expect(refund.error).toBe('payments API timed out after 5000 ms');
    expect(refund.toolResult).toBeUndefined();
    expect(trace!.totals.errors).toBe(1);
  });

  it('classifies by span name when gen_ai.operation.name is missing', () => {
    const doc = {
      resourceSpans: [
        { scopeSpans: [{ spans: [{ traceId: 't', spanId: 'a', name: 'execute_tool search', startTimeUnixNano: '1000000', endTimeUnixNano: '3000000' }] }] },
      ],
    };
    const [trace] = loadTraces(JSON.stringify(doc), 'x');
    expect(trace!.steps[0]).toMatchObject({ kind: 'tool', operation: 'execute_tool', durationMs: 2 });
  });

  it('reads content attributes from span events when they are not on the span', () => {
    const doc = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 'a',
                  name: 'chat m',
                  attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
                  events: [
                    {
                      name: 'gen_ai.client.inference.operation.details',
                      attributes: [{ key: 'gen_ai.output.messages', value: { stringValue: '[{"role":"assistant","parts":[{"type":"text","content":"hi"}]}]' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [trace] = loadTraces(JSON.stringify(doc), 'x');
    expect(trace!.steps[0]!.outputMessages).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'hi' }], finishReason: undefined }]);
  });
});

describe('parseMessages', () => {
  it('parses the conventions message schema, including tool calls and responses', () => {
    const msgs = parseMessages(
      JSON.stringify([
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'f', arguments: '{"x":1}' }], finish_reason: 'tool_calls' },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', response: { ok: true } }] },
      ]),
    );
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'f', arguments: { x: 1 } }], finishReason: 'tool_calls' },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', response: { ok: true } }], finishReason: undefined },
    ]);
  });

  it('treats a bare list of parts as system instructions and plain strings as text', () => {
    expect(parseMessages('[{"type":"text","content":"be brief"}]', 'system')).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be brief' }] },
    ]);
    expect(parseMessages('hello')).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]);
    expect(parseMessages(undefined)).toBeUndefined();
  });

  it('accepts the older {role, content} shape and keeps unknown parts', () => {
    const msgs = parseMessages([{ role: 'user', content: 'hi' }, { role: 'user', parts: [{ type: 'image', uri: 'x' }] }]);
    expect(msgs?.[0]?.parts).toEqual([{ type: 'text', content: 'hi' }]);
    expect(msgs?.[1]?.parts[0]).toEqual({ type: 'other', raw: { type: 'image', uri: 'x' } });
  });
});

describe('parseMaybeJson', () => {
  it('parses JSON strings and leaves other strings alone', () => {
    expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMaybeJson('[1,2]')).toEqual([1, 2]);
    expect(parseMaybeJson('{broken')).toBe('{broken');
    expect(parseMaybeJson('plain')).toBe('plain');
    expect(parseMaybeJson(3)).toBe(3);
  });
});
