import { formatMs, formatTokens, formatUsd } from '../lib/format';
import type { Step, Totals } from '../lib/types';

export function TotalsBar({ totals, label }: { totals: Totals; label?: string }) {
  const costTitle =
    totals.costUsd === undefined
      ? 'No span carries gen_ai.usage.cost_usd. Run the traces through otel-genai-cost to add prices.'
      : `${totals.pricedModelCalls} of ${totals.modelCalls} model calls priced`;
  return (
    <dl className="totals" aria-label={label ?? 'Run totals'}>
      <div>
        <dt>Input tokens</dt>
        <dd>{formatTokens(totals.inputTokens)}</dd>
        {totals.cacheReadTokens > 0 && <dd className="muted small">{formatTokens(totals.cacheReadTokens)} cached</dd>}
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd>{formatTokens(totals.outputTokens)}</dd>
      </div>
      <div title={costTitle}>
        <dt>Cost</dt>
        <dd>{formatUsd(totals.costUsd)}</dd>
        {totals.costUsd === undefined && <dd className="muted small">not priced</dd>}
      </div>
      <div>
        <dt>Latency</dt>
        <dd>{formatMs(totals.latencyMs)}</dd>
      </div>
      <div>
        <dt>Model calls</dt>
        <dd>{totals.modelCalls}</dd>
      </div>
      <div>
        <dt>Tool calls</dt>
        <dd>{totals.toolCalls}</dd>
      </div>
      {totals.errors > 0 && (
        <div className="error-text">
          <dt>Errors</dt>
          <dd>{totals.errors}</dd>
        </div>
      )}
    </dl>
  );
}

/** Compact per-step metric chips. */
export function StepMetrics({ step }: { step: Step }) {
  const { usage } = step;
  return (
    <ul className="chips" aria-label="Step metrics">
      {usage.inputTokens !== undefined && (
        <li title="Input tokens">
          in {formatTokens(usage.inputTokens)}
          {usage.cacheReadTokens ? ` (${formatTokens(usage.cacheReadTokens)} cached)` : ''}
        </li>
      )}
      {usage.outputTokens !== undefined && <li title="Output tokens">out {formatTokens(usage.outputTokens)}</li>}
      {step.costUsd !== undefined && <li title="gen_ai.usage.cost_usd">{formatUsd(step.costUsd)}</li>}
      <li title="Duration">{formatMs(step.durationMs)}</li>
    </ul>
  );
}
