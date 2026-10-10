import { useMemo } from 'react';
import { diffTraces, type DiffRow, type TraceDiff } from '../lib/diff';
import { formatDelta, formatJson, formatMs, formatTokens, formatUsd, percentChange } from '../lib/format';
import type { Step, Trace } from '../lib/types';

const STATUS_LABEL: Record<DiffRow['status'], string> = { same: 'same', changed: 'changed', added: 'only in B', removed: 'only in A' };

export function DiffView({ left, right }: { left: Trace; right: Trace }) {
  const diff = useMemo(() => diffTraces(left, right), [left, right]);
  return (
    <section aria-labelledby="diff-heading" className="panel">
      <h2 id="diff-heading">Diff</h2>
      <p className="muted">
        <strong>A</strong> {left.title} <span className="small">({left.source})</span> vs <strong>B</strong> {right.title}{' '}
        <span className="small">({right.source})</span>
      </p>
      <TotalsTable diff={diff} />
      <p className="summary" data-testid="diff-summary">
        {diff.counts.changed} changed · {diff.counts.added} only in B · {diff.counts.removed} only in A · {diff.counts.same} same
      </p>
      <ol className="diff-rows" aria-label="Aligned steps">
        {diff.rows.map((row, i) => (
          <DiffRowView key={i} row={row} />
        ))}
      </ol>
    </section>
  );
}

function TotalsTable({ diff }: { diff: TraceDiff }) {
  const { left: l, right: r, delta: d } = diff.totals;
  const rows: Array<[string, string, string, string, number | undefined]> = [
    ['Input tokens', formatTokens(l.inputTokens), formatTokens(r.inputTokens), formatDelta(d.inputTokens, 'tokens'), percentChange(l.inputTokens, r.inputTokens)],
    ['Output tokens', formatTokens(l.outputTokens), formatTokens(r.outputTokens), formatDelta(d.outputTokens, 'tokens'), percentChange(l.outputTokens, r.outputTokens)],
    ['Cost', formatUsd(l.costUsd), formatUsd(r.costUsd), formatDelta(d.costUsd, 'usd'), percentChange(l.costUsd, r.costUsd)],
    ['Latency', formatMs(l.latencyMs), formatMs(r.latencyMs), formatDelta(d.latencyMs, 'ms'), percentChange(l.latencyMs, r.latencyMs)],
    ['Model calls', String(l.modelCalls), String(r.modelCalls), formatDelta(d.modelCalls, 'count'), undefined],
    ['Tool calls', String(l.toolCalls), String(r.toolCalls), formatDelta(d.toolCalls, 'count'), undefined],
  ];
  return (
    <table className="totals-table" data-testid="totals-table">
      <caption className="visually-hidden">Run totals, A versus B</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">A</th>
          <th scope="col">B</th>
          <th scope="col">Δ (B − A)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, a, b, delta, pct]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{a}</td>
            <td>{b}</td>
            <td className={deltaClass(pct ?? (delta.startsWith('-') ? -1 : delta.startsWith('+') ? 1 : 0))}>
              {delta}
              {pct !== undefined && <span className="muted small"> ({pct > 0 ? '+' : ''}{pct.toFixed(0)}%)</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function deltaClass(n: number): string {
  return n > 0 ? 'delta up' : n < 0 ? 'delta down' : 'delta';
}

function DiffRowView({ row }: { row: DiffRow }) {
  return (
    <li className={`diff-row status-${row.status}`} data-testid="diff-row" data-status={row.status}>
      <div className="diff-cell">{row.left ? <StepSummary step={row.left} /> : <span className="muted small">—</span>}</div>
      <div className="diff-status">
        <span className={`badge status-${row.status}`}>{STATUS_LABEL[row.status]}</span>
      </div>
      <div className="diff-cell">{row.right ? <StepSummary step={row.right} /> : <span className="muted small">—</span>}</div>
      {(row.changes.length > 0 || (row.left && row.right)) && (
        <div className="diff-details">
          {row.left && row.right && <Deltas row={row} />}
          {row.changes.length > 0 && (
            <ul className="changes">
              {row.changes.map((c, i) => (
                <li key={i}>
                  {c.summary}
                  {c.details && c.details.length > 0 && (
                    <details>
                      <summary>show values</summary>
                      <table className="value-diff">
                        <thead>
                          <tr>
                            <th scope="col">path</th>
                            <th scope="col">A</th>
                            <th scope="col">B</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.details.map((v, j) => (
                            <tr key={j}>
                              <td>
                                <code>{v.path || '(value)'}</code>
                              </td>
                              <td>
                                <pre className="before">{v.before === undefined ? '—' : formatJson(v.before)}</pre>
                              </td>
                              <td>
                                <pre className="after">{v.after === undefined ? '—' : formatJson(v.after)}</pre>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Deltas({ row }: { row: DiffRow }) {
  const d = row.delta;
  const items: string[] = [];
  if (d.inputTokens !== undefined && d.inputTokens !== 0) items.push(`in ${formatDelta(d.inputTokens, 'tokens')}`);
  if (d.outputTokens !== undefined && d.outputTokens !== 0) items.push(`out ${formatDelta(d.outputTokens, 'tokens')}`);
  if (d.costUsd !== undefined && d.costUsd !== 0) items.push(`cost ${formatDelta(d.costUsd, 'usd')}`);
  if (d.durationMs !== undefined) items.push(`latency ${formatDelta(d.durationMs, 'ms')}`);
  if (items.length === 0) return null;
  return (
    <ul className="chips" aria-label="Deltas, B minus A">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function StepSummary({ step }: { step: Step }) {
  const tokens =
    step.usage.inputTokens !== undefined || step.usage.outputTokens !== undefined
      ? `${formatTokens(step.usage.inputTokens)} in / ${formatTokens(step.usage.outputTokens)} out`
      : undefined;
  return (
    <div className="step-summary">
      <span className={`badge kind-${step.kind}`}>{step.kind}</span> <strong>{step.label}</strong>
      <div className="muted small">
        {[tokens, step.costUsd !== undefined ? formatUsd(step.costUsd) : undefined, formatMs(step.durationMs)].filter(Boolean).join(' · ')}
      </div>
      {step.error && <div className="error-text small">Error: {step.error}</div>}
    </div>
  );
}
