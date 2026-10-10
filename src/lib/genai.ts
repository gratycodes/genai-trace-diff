import type { AttrValue, Message, MessagePart, Span, Step, StepKind, Totals, Trace } from './types';

/** Operation names from the OpenTelemetry GenAI semantic conventions. */
const MODEL_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings', 'completion']);
const AGENT_OPERATIONS = new Set(['invoke_agent', 'create_agent']);
const TOOL_OPERATIONS = new Set(['execute_tool']);

export const COST_ATTRIBUTE = 'gen_ai.usage.cost_usd';

/** Group spans by trace id and interpret each trace as an agent run. */
export function buildTraces(spans: Span[], source: string): Trace[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId);
    if (list) list.push(s);
    else byTrace.set(s.traceId, [s]);
  }
  const traces = [...byTrace.entries()].map(([traceId, list]) => buildTrace(traceId, list, source));
  return traces.sort((a, b) => a.startMs - b.startMs);
}

export function buildTrace(traceId: string, spans: Span[], source: string): Trace {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || depthOf(a, byId) - depthOf(b, byId));
  const startMs = ordered.length ? Math.min(...ordered.map((s) => s.startMs)) : 0;
  const steps = ordered.map((s) => toStep(s, depthOf(s, byId), startMs));
  const root = ordered.find((s) => !s.parentSpanId || !byId.has(s.parentSpanId)) ?? ordered[0];
  const serviceName = root ? asString(root.resource['service.name']) : undefined;
  return {
    traceId,
    title: root?.name ?? traceId,
    serviceName,
    source,
    startMs,
    steps,
    totals: computeTotals(steps, byId),
  };
}

function depthOf(span: Span, byId: Map<string, Span>): number {
  let depth = 0;
  let cur = span;
  const seen = new Set<string>();
  while (cur.parentSpanId && byId.has(cur.parentSpanId) && !seen.has(cur.parentSpanId)) {
    seen.add(cur.parentSpanId);
    cur = byId.get(cur.parentSpanId)!;
    depth++;
  }
  return depth;
}

export function classify(span: Span): { kind: StepKind; operation: string } {
  const op = asString(span.attributes['gen_ai.operation.name']);
  if (op) {
    if (MODEL_OPERATIONS.has(op)) return { kind: 'model', operation: op };
    if (AGENT_OPERATIONS.has(op)) return { kind: 'agent', operation: op };
    if (TOOL_OPERATIONS.has(op)) return { kind: 'tool', operation: op };
    return { kind: 'other', operation: op };
  }
  // No operation attribute: fall back to the span-name convention "{operation} {target}".
  const first = span.name.split(' ')[0] ?? '';
  if (MODEL_OPERATIONS.has(first)) return { kind: 'model', operation: first };
  if (AGENT_OPERATIONS.has(first)) return { kind: 'agent', operation: first };
  if (TOOL_OPERATIONS.has(first)) return { kind: 'tool', operation: first };
  return { kind: 'other', operation: span.name };
}

function toStep(span: Span, depth: number, traceStartMs: number): Step {
  const a = span.attributes;
  const { kind, operation } = classify(span);
  const model = asString(a['gen_ai.response.model']) ?? asString(a['gen_ai.request.model']);
  const toolName = asString(a['gen_ai.tool.name']);
  const agentName = asString(a['gen_ai.agent.name']);
  const label =
    kind === 'tool' ? (toolName ?? span.name) : kind === 'model' ? (model ?? span.name) : kind === 'agent' ? (agentName ?? span.name) : span.name;
  const finish = a['gen_ai.response.finish_reasons'];
  const errorType = asString(a['error.type']);
  return {
    span,
    kind,
    operation,
    label,
    depth,
    offsetMs: span.startMs - traceStartMs,
    durationMs: Math.max(0, span.endMs - span.startMs),
    model,
    agentName,
    toolName,
    toolCallId: asString(a['gen_ai.tool.call.id']),
    toolArguments: parseMaybeJson(findAttr(span, 'gen_ai.tool.call.arguments')),
    toolResult: parseMaybeJson(findAttr(span, 'gen_ai.tool.call.result')),
    usage: {
      inputTokens: asNumber(a['gen_ai.usage.input_tokens']),
      outputTokens: asNumber(a['gen_ai.usage.output_tokens']),
      cacheReadTokens: asNumber(a['gen_ai.usage.cache_read.input_tokens']),
    },
    costUsd: asNumber(a[COST_ATTRIBUTE]),
    systemInstructions: parseMessages(findAttr(span, 'gen_ai.system_instructions'), 'system'),
    inputMessages: parseMessages(findAttr(span, 'gen_ai.input.messages')),
    outputMessages: parseMessages(findAttr(span, 'gen_ai.output.messages'), 'assistant'),
    finishReasons: Array.isArray(finish) ? finish.map(String) : typeof finish === 'string' ? [finish] : undefined,
    error: span.status.code === 'error' ? (span.status.message ?? errorType ?? 'error') : errorType,
  };
}

/**
 * Content attributes may sit on the span or, with newer instrumentations, on a span event
 * (e.g. "gen_ai.client.inference.operation.details"). Span attributes win.
 */
function findAttr(span: Span, key: string): AttrValue | undefined {
  if (key in span.attributes) return span.attributes[key];
  for (const e of span.events) if (key in e.attributes) return e.attributes[key];
  return undefined;
}

/** Content attributes are usually JSON-encoded strings. Leave non-JSON strings alone. */
export function parseMaybeJson(v: AttrValue | undefined): AttrValue | undefined {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t) as AttrValue;
  } catch {
    return v;
  }
}

/**
 * Parse gen_ai.input.messages / gen_ai.output.messages / gen_ai.system_instructions.
 * The conventions define a list of {role, parts:[...]} objects; system instructions are a
 * bare list of parts. A plain string is treated as one text message.
 */
export function parseMessages(raw: AttrValue | undefined, defaultRole = 'user'): Message[] | undefined {
  const v = parseMaybeJson(raw);
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [{ role: defaultRole, parts: [{ type: 'text', content: v }] }];
  if (!Array.isArray(v)) return undefined;
  if (v.every((item) => isRecord(item) && !('role' in item) && 'type' in item)) {
    return [{ role: defaultRole, parts: v.map(parsePart) }];
  }
  return v.filter(isRecord).map((m) => {
    const parts = Array.isArray(m.parts)
      ? m.parts.map(parsePart)
      : typeof m.content === 'string'
        ? [{ type: 'text' as const, content: m.content }]
        : [];
    return {
      role: asString(m.role) ?? defaultRole,
      parts,
      finishReason: asString(m.finish_reason),
    };
  });
}

function parsePart(p: AttrValue): MessagePart {
  if (typeof p === 'string') return { type: 'text', content: p };
  if (!isRecord(p)) return { type: 'other', raw: p };
  switch (p.type) {
    case 'text':
      return { type: 'text', content: asString(p.content) ?? '' };
    case 'tool_call':
      return { type: 'tool_call', id: asString(p.id), name: asString(p.name) ?? '?', arguments: parseMaybeJson(p.arguments) };
    case 'tool_call_response':
      return { type: 'tool_call_response', id: asString(p.id), response: parseMaybeJson(p.response ?? p.result) };
    default:
      return { type: 'other', raw: p };
  }
}

export function computeTotals(steps: Step[], byId: Map<string, Span>): Totals {
  const model = steps.filter((s) => s.kind === 'model');
  // Agent spans often repeat the summed usage of their children (agent-runtime-kit does).
  // Count model calls only, and use top-level agent spans as a fallback when no model span has usage.
  let usageSteps = model.filter((s) => hasUsage(s));
  if (usageSteps.length === 0) {
    usageSteps = steps.filter((s) => s.kind === 'agent' && hasUsage(s) && !hasAgentAncestor(s.span, byId));
  }
  const priced = model.filter((s) => s.costUsd !== undefined);
  const costSteps = priced.length > 0 ? priced : usageSteps.filter((s) => s.costUsd !== undefined);
  const starts = steps.map((s) => s.span.startMs);
  const ends = steps.map((s) => s.span.endMs);
  return {
    inputTokens: sum(usageSteps.map((s) => s.usage.inputTokens)),
    outputTokens: sum(usageSteps.map((s) => s.usage.outputTokens)),
    cacheReadTokens: sum(usageSteps.map((s) => s.usage.cacheReadTokens)),
    costUsd: costSteps.length > 0 ? sum(costSteps.map((s) => s.costUsd)) : undefined,
    pricedModelCalls: priced.length,
    latencyMs: steps.length ? Math.max(...ends) - Math.min(...starts) : 0,
    modelCalls: model.length,
    toolCalls: steps.filter((s) => s.kind === 'tool').length,
    errors: steps.filter((s) => s.span.status.code === 'error').length,
  };
}

function hasUsage(s: Step): boolean {
  return s.usage.inputTokens !== undefined || s.usage.outputTokens !== undefined;
}

function hasAgentAncestor(span: Span, byId: Map<string, Span>): boolean {
  let cur = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.spanId)) {
    if (classify(cur).kind === 'agent') return true;
    seen.add(cur.spanId);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return false;
}

function sum(values: (number | undefined)[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

export function asString(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
}

export function asNumber(v: AttrValue | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function isRecord(v: AttrValue | undefined): v is { [key: string]: AttrValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

