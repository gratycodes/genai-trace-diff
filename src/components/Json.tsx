import { formatJson } from '../lib/format';

export function Json({ value, label }: { value: unknown; label: string }) {
  return (
    <figure className="json">
      <figcaption>{label}</figcaption>
      <pre>
        <code>{formatJson(value)}</code>
      </pre>
    </figure>
  );
}
