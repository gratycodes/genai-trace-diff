import type { AttrValue, Step, Totals, Trace } from './types';

export type RowStatus = 'same' | 'changed' | 'added' | 'removed';

export interface ValueChange {
  /** Dotted path inside the value, '' for the value itself. */
  path: string;
  before?: AttrValue;
  after?: AttrValue;
}

export type ChangeKind = 'model' | 'arguments' | 'result' | 'output' | 'tokens' | 'error' | 'finish_reason';

export interface Change {
  kind: ChangeKind;
  summary: string;
  details?: ValueChange[];
}

export interface DiffRow {
  status: RowStatus;
  left?: Step;
  right?: Step;
  changes: Change[];
  /** right minus left; undefined when either side is missing or the field is absent. */
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs?: number;
  };
}

export interface TraceDiff {
  rows: DiffRow[];
  totals: { left: Totals; right: Totals; delta: TotalsDelta };
  counts: Record<RowStatus, number>;
}

export interface TotalsDelta {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
}

/**
 * The identity used to line steps up. Tool steps match on the tool name, model steps on the
 * operation (so a model swap shows up as a change, not as remove + add), agent steps on the
 * agent name, anything else on the span name.
 */
export function alignmentKey(step: Step): string {
  switch (step.kind) {
    case 'tool':
      return `tool:${step.toolName ?? step.span.name}`;
    case 'model':
      return `model:${step.operation}`;
    case 'agent':
      return `agent:${step.agentName ?? step.span.name}`;
    default:
      return `other:${step.span.name}`;
  }
}

/**
 * Align two step sequences with a longest-common-subsequence over alignment keys.
 * Returns index pairs in order; a missing index means the step exists on one side only.
 *
 * The table is built over prefixes and walked back from the end, so ties resolve toward
 * matching the last steps (the final answers) with each other. Inside a gap, removed steps
 * are listed before added ones.
 */
export function alignSteps(left: Step[], right: Step[]): Array<[number | undefined, number | undefined]> {
  const a = left.map(alignmentKey);
  const b = right.map(alignmentKey);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[:i] and b[:j]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      lcs[i]![j] = a[i - 1] === b[j - 1] ? lcs[i - 1]![j - 1]! + 1 : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
    }
  }
  const reversed: Array<[number | undefined, number | undefined]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      reversed.push([--i, --j]);
    } else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
      reversed.push([undefined, --j]);
    } else {
      reversed.push([--i, undefined]);
    }
  }
  return reversed.reverse();
}

export function diffTraces(left: Trace, right: Trace): TraceDiff {
  const rows = alignSteps(left.steps, right.steps).map(([li, ri]) =>
    diffStep(li === undefined ? undefined : left.steps[li], ri === undefined ? undefined : right.steps[ri]),
  );
  const counts: Record<RowStatus, number> = { same: 0, changed: 0, added: 0, removed: 0 };
  for (const r of rows) counts[r.status]++;
  const l = left.totals;
  const r = right.totals;
  return {
    rows,
    counts,
    totals: {
      left: l,
      right: r,
      delta: {
        inputTokens: r.inputTokens - l.inputTokens,
        outputTokens: r.outputTokens - l.outputTokens,
        costUsd: l.costUsd !== undefined && r.costUsd !== undefined ? r.costUsd - l.costUsd : undefined,
        latencyMs: r.latencyMs - l.latencyMs,
        modelCalls: r.modelCalls - l.modelCalls,
        toolCalls: r.toolCalls - l.toolCalls,
      },
    },
  };
}

export function diffStep(left: Step | undefined, right: Step | undefined): DiffRow {
  if (!left && !right) throw new Error('diffStep needs at least one step');
  if (!left) return { status: 'added', right, changes: [], delta: {} };
  if (!right) return { status: 'removed', left, changes: [], delta: {} };

  const changes: Change[] = [];
  if (left.model !== right.model && (left.model || right.model)) {
    changes.push({ kind: 'model', summary: `model ${left.model ?? '—'} → ${right.model ?? '—'}` });
  }
  if (left.kind === 'tool') {
    const args = diffValues(left.toolArguments, right.toolArguments);
    if (args.length) changes.push({ kind: 'arguments', summary: summarise('arguments', args), details: args });
    const res = diffValues(left.toolResult, right.toolResult);
    if (res.length) changes.push({ kind: 'result', summary: summarise('result', res), details: res });
  }
  if (left.kind === 'model') {
    const before = outputText(left);
    const after = outputText(right);
    if (before !== after) changes.push({ kind: 'output', summary: 'model output changed', details: [{ path: '', before, after }] });
    const lt = toolCallNames(left);
    const rt = toolCallNames(right);
    if (lt !== rt) changes.push({ kind: 'output', summary: `requested tools ${lt || 'none'} → ${rt || 'none'}` });
    if ((left.finishReasons ?? []).join() !== (right.finishReasons ?? []).join()) {
      changes.push({
        kind: 'finish_reason',
        summary: `finish reason ${left.finishReasons?.join(', ') || '—'} → ${right.finishReasons?.join(', ') || '—'}`,
      });
    }
    if (left.usage.inputTokens !== right.usage.inputTokens || left.usage.outputTokens !== right.usage.outputTokens) {
      changes.push({ kind: 'tokens', summary: 'token usage changed' });
    }
  }
  if ((left.error ?? '') !== (right.error ?? '')) {
    changes.push({ kind: 'error', summary: right.error ? `now fails: ${right.error}` : `no longer fails (was: ${left.error})` });
  }

  return {
    status: changes.length ? 'changed' : 'same',
    left,
    right,
    changes,
    delta: {
      inputTokens: sub(right.usage.inputTokens, left.usage.inputTokens),
      outputTokens: sub(right.usage.outputTokens, left.usage.outputTokens),
      costUsd: sub(right.costUsd, left.costUsd),
      durationMs: right.durationMs - left.durationMs,
    },
  };
}

function sub(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a - b;
}

function summarise(what: string, changes: ValueChange[]): string {
  const paths = changes.map((c) => c.path || '(value)');
  const shown = paths.slice(0, 3).join(', ');
  return `${what} changed: ${shown}${paths.length > 3 ? ` +${paths.length - 3} more` : ''}`;
}

function outputText(step: Step): string {
  return (step.outputMessages ?? [])
    .flatMap((m) => m.parts)
    .map((p) => (p.type === 'text' ? p.content : ''))
    .join('\n')
    .trim();
}

function toolCallNames(step: Step): string {
  return (step.outputMessages ?? [])
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === 'tool_call' ? [p.name] : []))
    .join(', ');
}

/** Structural diff of two JSON-like values, reported as leaf paths. */
export function diffValues(before: AttrValue | undefined, after: AttrValue | undefined, path = ''): ValueChange[] {
  if (deepEqual(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffValues(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((v, i) => diffValues(v, after[i], `${path}[${i}]`));
  }
  return [{ path, before, after }];
}

export function deepEqual(a: AttrValue | undefined, b: AttrValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function isPlainObject(v: AttrValue | undefined): v is { [key: string]: AttrValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
