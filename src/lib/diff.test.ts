import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignSteps, alignmentKey, deepEqual, diffStep, diffTraces, diffValues } from './diff';
import { formatDelta, formatMs, formatUsd, percentChange } from './format';
import { loadTraces } from './load';
import type { Step, Trace } from './types';

const load = (name: string): Trace =>
  loadTraces(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'), name)[0]!;

function step(kind: Step['kind'], name: string, extra: Partial<Step> = {}): Step {
  return {
    span: { traceId: 't', spanId: name, name, startMs: 0, endMs: 10, attributes: {}, resource: {}, events: [], status: { code: 'unset' } },
    kind,
    operation: kind === 'model' ? 'chat' : kind === 'tool' ? 'execute_tool' : kind === 'agent' ? 'invoke_agent' : name,
    label: name,
    depth: 0,
    offsetMs: 0,
    durationMs: 10,
    toolName: kind === 'tool' ? name : undefined,
    agentName: kind === 'agent' ? name : undefined,
    usage: {},
    ...extra,
  };
}

const keys = (pairs: Array<[number | undefined, number | undefined]>, l: Step[], r: Step[]) =>
  pairs.map(([i, j]) => [i === undefined ? null : l[i]!.label, j === undefined ? null : r[j]!.label]);

describe('alignmentKey', () => {
  it('matches tools by name and model calls by operation, not model', () => {
    expect(alignmentKey(step('tool', 'search'))).toBe('tool:search');
    expect(alignmentKey(step('model', 'a', { model: 'm1' }))).toBe(alignmentKey(step('model', 'b', { model: 'm2' })));
    expect(alignmentKey(step('agent', 'bot'))).toBe('agent:bot');
    expect(alignmentKey(step('other', 'GET /orders'))).toBe('other:GET /orders');
  });
});

describe('alignSteps', () => {
  it('pairs identical sequences one to one', () => {
    const l = [step('agent', 'bot'), step('model', 'c1'), step('tool', 'search')];
    const r = [step('agent', 'bot'), step('model', 'c2'), step('tool', 'search')];
    expect(keys(alignSteps(l, r), l, r)).toEqual([
      ['bot', 'bot'],
      ['c1', 'c2'],
      ['search', 'search'],
    ]);
  });

  it('reports removed and added steps, removed first inside a gap', () => {
    const l = [step('model', 'plan'), step('tool', 'policy'), step('model', 'answer')];
    const r = [step('model', 'plan'), step('tool', 'refund'), step('model', 'answer')];
    expect(keys(alignSteps(l, r), l, r)).toEqual([
      ['plan', 'plan'],
      ['policy', null],
      [null, 'refund'],
      ['answer', 'answer'],
    ]);
  });

  it('lines up final answers when the new run has extra model turns', () => {
    const l = [step('model', 'L1'), step('tool', 'lookup'), step('model', 'Lfinal')];
    const r = [step('model', 'R1'), step('tool', 'lookup'), step('model', 'R2'), step('tool', 'refund'), step('model', 'Rfinal')];
    expect(keys(alignSteps(l, r), l, r)).toEqual([
      ['L1', 'R1'],
      ['lookup', 'lookup'],
      [null, 'R2'],
      [null, 'refund'],
      ['Lfinal', 'Rfinal'],
    ]);
  });

  it('handles empty sides', () => {
    const r = [step('tool', 'a'), step('tool', 'b')];
    expect(alignSteps([], r)).toEqual([
      [undefined, 0],
      [undefined, 1],
    ]);
    expect(alignSteps(r, [])).toEqual([
      [0, undefined],
      [1, undefined],
    ]);
    expect(alignSteps([], [])).toEqual([]);
  });
});

describe('diffValues', () => {
  it('reports leaf paths for nested changes', () => {
    expect(diffValues({ a: 1, b: { c: 2, d: [1, 2] } }, { a: 1, b: { c: 3, d: [1, 5] }, e: true })).toEqual([
      { path: 'b.c', before: 2, after: 3 },
      { path: 'b.d[1]', before: 2, after: 5 },
      { path: 'e', before: undefined, after: true },
    ]);
  });

  it('treats arrays of different length and type changes as whole-value changes', () => {
    expect(diffValues({ x: [1] }, { x: [1, 2] })).toEqual([{ path: 'x', before: [1], after: [1, 2] }]);
    expect(diffValues('a', { a: 1 })).toEqual([{ path: '', before: 'a', after: { a: 1 } }]);
    expect(diffValues({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('deepEqual ignores key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined as never })).toBe(false);
  });
});

describe('diffStep', () => {
  it('flags changed tool arguments and results with paths', () => {
    const row = diffStep(
      step('tool', 'lookup', { toolArguments: { id: 'A' }, toolResult: { ok: true } }),
      step('tool', 'lookup', { toolArguments: { id: 'A', include: ['items'] }, toolResult: { ok: true } }),
    );
    expect(row.status).toBe('changed');
    expect(row.changes).toHaveLength(1);
    expect(row.changes[0]).toMatchObject({ kind: 'arguments', summary: 'arguments changed: include' });
  });

  it('computes token, cost and latency deltas as right minus left', () => {
    const row = diffStep(
      step('model', 'a', { usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.01, durationMs: 900 }),
      step('model', 'b', { usage: { inputTokens: 80, outputTokens: 10 }, costUsd: 0.004, durationMs: 400 }),
    );
    expect(row.delta.inputTokens).toBe(-20);
    expect(row.delta.outputTokens).toBe(0);
    expect(row.delta.costUsd).toBeCloseTo(-0.006, 9);
    expect(row.delta.durationMs).toBe(-500);
    expect(row.changes.map((c) => c.kind)).toEqual(['tokens']);
  });

  it('leaves cost delta undefined when one side is unpriced', () => {
    const row = diffStep(step('model', 'a', { costUsd: 0.01 }), step('model', 'b'));
    expect(row.delta.costUsd).toBeUndefined();
  });

  it('marks latency-only differences as same and reports new failures', () => {
    expect(diffStep(step('tool', 'x', { durationMs: 1 }), step('tool', 'x', { durationMs: 99 })).status).toBe('same');
    const failed = diffStep(step('tool', 'x'), step('tool', 'x', { error: 'timeout' }));
    expect(failed.changes).toEqual([{ kind: 'error', summary: 'now fails: timeout' }]);
  });

  it('marks one-sided rows as added or removed', () => {
    expect(diffStep(undefined, step('tool', 'x')).status).toBe('added');
    expect(diffStep(step('tool', 'x'), undefined).status).toBe('removed');
    expect(() => diffStep(undefined, undefined)).toThrow();
  });
});

describe('diffTraces on the refund fixtures', () => {
  const v1 = load('refund-v1.otlp.json');
  const v2 = load('refund-v2.otlp.json');
  const d = diffTraces(v1, v2);

  it('aligns the v1 and v2 runs step by step', () => {
    expect(d.rows.map((r) => [r.status, r.left?.label ?? null, r.right?.label ?? null])).toEqual([
      ['same', 'support-bot', 'support-bot'],
      ['changed', 'example-large-2026-09-01', 'example-small-2026-09-01'],
      ['changed', 'lookup_order', 'lookup_order'],
      ['removed', 'refund_policy', null],
      ['added', null, 'example-small-2026-09-01'],
      ['added', null, 'issue_refund'],
      ['changed', 'example-large-2026-09-01', 'example-large-2026-09-01'],
    ]);
    expect(d.counts).toEqual({ same: 1, changed: 3, added: 2, removed: 1 });
  });

  it('explains what changed in each step', () => {
    const plan = d.rows[1]!.changes.map((c) => c.summary);
    expect(plan).toContain('model example-large-2026-09-01 → example-small-2026-09-01');
    expect(plan).toContain('requested tools lookup_order, refund_policy → lookup_order');
    const lookup = d.rows[2]!.changes.map((c) => c.summary);
    expect(lookup).toEqual(['arguments changed: include', 'result changed: items']);
    expect(d.rows[6]!.changes.map((c) => c.kind)).toEqual(['output', 'tokens']);
  });

  it('reports run-level deltas', () => {
    expect(d.totals.delta).toMatchObject({ inputTokens: 1600, outputTokens: 13, modelCalls: 1, toolCalls: 0 });
    expect(d.totals.delta.costUsd).toBeCloseTo(0.0044649 - 0.00594, 9);
    expect(d.totals.delta.latencyMs).toBeCloseTo(3490 - 5240, 3);
  });

  it('diffing a trace with itself yields no changes', () => {
    const self = diffTraces(v1, v1);
    expect(self.counts).toEqual({ same: v1.steps.length, changed: 0, added: 0, removed: 0 });
  });
});

describe('format', () => {
  it('formats money, durations and signed deltas', () => {
    expect(formatUsd(0.00594)).toBe('$0.005940');
    expect(formatUsd(0.25)).toBe('$0.2500');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatMs(0.25)).toBe('250 µs');
    expect(formatMs(212)).toBe('212 ms');
    expect(formatMs(5240)).toBe('5.24 s');
    expect(formatDelta(-1475, 'usd')).toBe('-$1475.00');
    expect(formatDelta(1600, 'tokens')).toBe('+1,600');
    expect(formatDelta(0, 'ms')).toBe('±0');
    expect(percentChange(200, 150)).toBe(-25);
    expect(percentChange(0, 5)).toBeUndefined();
  });
});
