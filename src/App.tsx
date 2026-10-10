import { useState } from 'react';
import { DiffView } from './components/DiffView';
import { FileLoader } from './components/FileLoader';
import { Timeline } from './components/Timeline';
import { formatMs, formatTokens, formatUsd } from './lib/format';
import { loadTraces } from './lib/load';
import type { Trace } from './lib/types';
import { SAMPLE_FILES } from './samples';

interface Loaded extends Trace {
  id: string;
}

type View = 'timeline' | 'diff';

export default function App() {
  const [traces, setTraces] = useState<Loaded[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [view, setView] = useState<View>('timeline');
  const [selected, setSelected] = useState<string>();
  const [diffA, setDiffA] = useState<string>();
  const [diffB, setDiffB] = useState<string>();

  function addFiles(files: Array<{ name: string; text: string }>, nextView?: View) {
    const added: Loaded[] = [];
    const failed: string[] = [];
    const existing = new Set(traces.map((t) => t.id));
    for (const f of files) {
      try {
        const parsed = loadTraces(f.text, f.name);
        if (parsed.length === 0) failed.push(`${f.name}: no spans found`);
        for (const t of parsed) {
          const id = `${f.name}#${t.traceId}`;
          if (!existing.has(id)) {
            existing.add(id);
            added.push({ ...t, id });
          }
        }
      } catch (err) {
        failed.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    const all = [...traces, ...added];
    setTraces(all);
    setErrors(failed);
    setStatus(`Loaded ${added.length} trace${added.length === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}.`);
    if (!selected && all[0]) setSelected(all[0].id);
    if (!diffA && all[0]) setDiffA(all[0].id);
    if (!diffB && all[1]) setDiffB(all[1].id);
    if (nextView) setView(nextView);
  }

  function clear() {
    setTraces([]);
    setErrors([]);
    setSelected(undefined);
    setDiffA(undefined);
    setDiffB(undefined);
    setStatus('Cleared all traces.');
  }

  const current = traces.find((t) => t.id === selected);
  const left = traces.find((t) => t.id === diffA);
  const right = traces.find((t) => t.id === diffB);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <h1>genai-trace-diff</h1>
        <p>Read and compare OpenTelemetry GenAI traces as conversations. Runs entirely in your browser.</p>
      </header>
      <main id="main">
        <FileLoader
          onFiles={(files) => addFiles(files)}
          onLoadSamples={() => addFiles(SAMPLE_FILES, 'diff')}
          onClear={clear}
          hasTraces={traces.length > 0}
        />
        <p role="status" aria-live="polite" className="muted small" data-testid="load-status">
          {status}
        </p>
        {errors.length > 0 && (
          <div role="alert" className="panel error-panel">
            <h2>Some files could not be read</h2>
            <ul>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {traces.length > 0 && (
          <>
            <TraceTable traces={traces} selected={selected} onSelect={(id) => {
              setSelected(id);
              setView('timeline');
            }} />

            <nav className="view-switch" aria-label="View">
              <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
                Timeline
              </button>
              <button type="button" aria-pressed={view === 'diff'} onClick={() => setView('diff')} disabled={traces.length < 2}>
                Diff two traces
              </button>
            </nav>

            {view === 'timeline' && current && <Timeline trace={current} />}

            {view === 'diff' && (
              <>
                <div className="panel row gap wrap diff-pickers">
                  <TracePicker label="A (baseline)" traces={traces} value={diffA} onChange={setDiffA} />
                  <button
                    type="button"
                    onClick={() => {
                      setDiffA(diffB);
                      setDiffB(diffA);
                    }}
                    aria-label="Swap A and B"
                  >
                    ⇄ Swap
                  </button>
                  <TracePicker label="B (candidate)" traces={traces} value={diffB} onChange={setDiffB} />
                </div>
                {left && right ? <DiffView left={left} right={right} /> : <p className="muted">Pick two traces to compare.</p>}
              </>
            )}
          </>
        )}

        {traces.length === 0 && <EmptyState />}
      </main>
      <footer className="site-footer muted small">
        MIT licensed · <a href="https://github.com/gratycodes/genai-trace-diff">source on GitHub</a> · costs come from{' '}
        <code>gen_ai.usage.cost_usd</code> (see <a href="https://github.com/gratycodes/otel-genai-cost">otel-genai-cost</a>)
      </footer>
    </>
  );
}

function TraceTable({ traces, selected, onSelect }: { traces: Loaded[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <section aria-labelledby="traces-heading" className="panel">
      <h2 id="traces-heading">Traces ({traces.length})</h2>
      <div className="table-scroll">
        <table className="trace-table" data-testid="trace-table">
          <thead>
            <tr>
              <th scope="col">Trace</th>
              <th scope="col">File</th>
              <th scope="col">Model calls</th>
              <th scope="col">Tool calls</th>
              <th scope="col">Tokens (in / out)</th>
              <th scope="col">Cost</th>
              <th scope="col">Latency</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id} aria-current={t.id === selected ? 'true' : undefined}>
                <th scope="row">
                  <button type="button" className="link-button" onClick={() => onSelect(t.id)}>
                    {t.title}
                  </button>
                  <div className="muted small mono">{t.traceId.slice(0, 16)}</div>
                </th>
                <td>{t.source}</td>
                <td>{t.totals.modelCalls}</td>
                <td>
                  {t.totals.toolCalls}
                  {t.totals.errors > 0 && <span className="error-text small"> ({t.totals.errors} failed)</span>}
                </td>
                <td>
                  {formatTokens(t.totals.inputTokens)} / {formatTokens(t.totals.outputTokens)}
                </td>
                <td>{formatUsd(t.totals.costUsd)}</td>
                <td>{formatMs(t.totals.latencyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TracePicker({ label, traces, value, onChange }: { label: string; traces: Loaded[]; value?: string; onChange: (id: string) => void }) {
  return (
    <label className="picker">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          Choose a trace
        </option>
        {traces.map((t) => (
          <option key={t.id} value={t.id}>
            {t.source} · {t.title} · {t.traceId.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyState() {
  return (
    <section className="panel empty">
      <h2>What this does</h2>
      <ul>
        <li>Turns spans that follow the OpenTelemetry GenAI conventions (invoke_agent, chat, execute_tool) into a readable conversation.</li>
        <li>Shows tokens, latency and, when present, cost for every step and for the whole run.</li>
        <li>Lines up two runs step by step, for example before and after a prompt or model change, and shows what changed.</li>
      </ul>
      <p className="muted">No traces of your own? Use “Load sample traces”. They are synthetic.</p>
    </section>
  );
}
