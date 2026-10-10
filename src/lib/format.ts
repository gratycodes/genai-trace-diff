export function formatTokens(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('en-US');
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined) return '—';
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '-' : '';
  if (abs < 1) return `${sign}${(abs * 1000).toFixed(0)} µs`;
  if (abs < 1000) return `${sign}${abs.toFixed(abs < 10 ? 1 : 0)} ms`;
  return `${sign}${(abs / 1000).toFixed(2)} s`;
}

/** Signed delta, e.g. "+120" / "-0.0012". `kind` picks the unit formatter. */
export function formatDelta(n: number | undefined, kind: 'tokens' | 'usd' | 'ms' | 'count'): string {
  if (n === undefined) return '—';
  if (n === 0) return '±0';
  const sign = n > 0 ? '+' : '-';
  const abs = Math.abs(n);
  const body = kind === 'usd' ? formatUsd(abs) : kind === 'ms' ? formatMs(abs) : formatTokens(abs);
  return `${sign}${body}`;
}

/** Percentage change, or undefined when the base is zero. */
export function percentChange(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined || before === 0) return undefined;
  return ((after - before) / before) * 100;
}

export function formatJson(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}
