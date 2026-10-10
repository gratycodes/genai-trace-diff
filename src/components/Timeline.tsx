import type { Step, Trace } from '../lib/types';
import { Json } from './Json';
import { MessageList } from './Messages';
import { StepMetrics, TotalsBar } from './Metrics';

const KIND_LABEL: Record<Step['kind'], string> = { agent: 'agent', model: 'model call', tool: 'tool call', other: 'span' };

export function Timeline({ trace }: { trace: Trace }) {
  const total = trace.totals.latencyMs || 1;
  const skips = inputSkips(trace.steps);
  return (
    <section aria-labelledby="timeline-heading" className="panel">
      <h2 id="timeline-heading">
        {trace.title} <span className="muted small">{trace.source}</span>
      </h2>
      <TotalsBar totals={trace.totals} />
      <ol className="timeline" aria-label="Steps">
        {trace.steps.map((step, i) => (
          <StepCard key={step.span.spanId} step={step} total={total} skipInput={skips[i]} />
        ))}
      </ol>
    </section>
  );
}

/**
 * Chat histories are cumulative: each model call resends the whole conversation. Show only
 * what is new since the previous model call (its input plus its output), and keep the rest
 * behind a disclosure.
 */
export function inputSkips(steps: Step[]): number[] {
  let prev: Step | undefined;
  return steps.map((step) => {
    if (step.kind !== 'model') return 0;
    const before = prev;
    prev = step;
    if (!before || !step.inputMessages) return 0;
    const seen = (before.inputMessages?.length ?? 0) + (before.outputMessages?.length ?? 0);
    return seen <= step.inputMessages.length ? seen : 0;
  });
}

export function StepCard({ step, total, skipInput = 0 }: { step: Step; total: number; skipInput?: number }) {
  const left = (step.offsetMs / total) * 100;
  const width = Math.max((step.durationMs / total) * 100, 0.5);
  const newInput = step.inputMessages?.slice(skipInput) ?? [];
  return (
    <li
      className={`step kind-${step.kind}${step.error ? ' has-error' : ''}`}
      style={{ marginInlineStart: `${Math.min(step.depth, 6) * 1.25}rem` }}
      data-testid="step"
    >
      <header className="step-header">
        <span className={`badge kind-${step.kind}`}>{KIND_LABEL[step.kind]}</span>
        <h3>{step.label}</h3>
        {step.toolCallId && <span className="muted small">{step.toolCallId}</span>}
        <StepMetrics step={step} />
      </header>
      <div className="waterfall" aria-hidden="true">
        <span style={{ left: `${Math.min(left, 99.5)}%`, width: `${Math.min(width, 100 - left)}%` }} />
      </div>
      {step.error && (
        <p className="error-text" role="note">
          Error: {step.error}
        </p>
      )}
      {step.kind === 'model' && (
        <>
          {newInput.length > 0 && <MessageList messages={newInput} />}
          {step.outputMessages && <MessageList messages={step.outputMessages} />}
          {(step.systemInstructions || (step.inputMessages && skipInput > 0)) && (
            <details>
              <summary>
                Full prompt ({step.inputMessages?.length ?? 0} messages{step.systemInstructions ? ' + system instructions' : ''})
              </summary>
              {step.systemInstructions && <MessageList messages={step.systemInstructions} />}
              {step.inputMessages && <MessageList messages={step.inputMessages} />}
            </details>
          )}
          {!step.inputMessages && !step.outputMessages && (
            <p className="muted small">No message content recorded (content capture is usually off by default).</p>
          )}
        </>
      )}
      {step.kind === 'tool' && (
        <div className="tool-io">
          {step.toolArguments !== undefined && <Json value={step.toolArguments} label="arguments" />}
          {step.toolResult !== undefined && <Json value={step.toolResult} label="result" />}
          {step.toolArguments === undefined && step.toolResult === undefined && (
            <p className="muted small">No arguments or result recorded.</p>
          )}
        </div>
      )}
    </li>
  );
}
