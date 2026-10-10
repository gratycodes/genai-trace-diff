import { useId, useRef, useState, type DragEvent } from 'react';

interface Props {
  onFiles: (files: Array<{ name: string; text: string }>) => void;
  onLoadSamples: () => void;
  onClear: () => void;
  hasTraces: boolean;
}

export function FileLoader({ onFiles, onLoadSamples, onClear, hasTraces }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();

  async function readAll(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = await Promise.all(Array.from(list, async (f) => ({ name: f.name, text: await f.text() })));
    onFiles(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void readAll(e.dataTransfer.files);
  }

  return (
    <section aria-labelledby="load-heading" className="panel">
      <h2 id="load-heading">Load traces</h2>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <p>
          Drop OTLP/JSON trace files here, or{' '}
          <button type="button" className="link-button" onClick={() => inputRef.current?.click()}>
            choose files
          </button>
          .
        </p>
        <p id={hintId} className="muted small">
          Files are read in your browser and never uploaded. JSON and JSON Lines (Collector file exporter) both work.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".json,.jsonl,application/json"
          multiple
          hidden
          aria-describedby={hintId}
          data-testid="file-input"
          onChange={(e) => {
            void readAll(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="row gap">
        <button type="button" className="primary" onClick={onLoadSamples}>
          Load sample traces
        </button>
        {hasTraces && (
          <button type="button" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
    </section>
  );
}
