import type { Message, MessagePart } from '../lib/types';
import { Json } from './Json';

export function MessageList({ messages }: { messages: Message[] }) {
  return (
    <ol className="messages">
      {messages.map((m, i) => (
        <li key={i} className={`bubble role-${roleClass(m.role)}`}>
          <span className="role">{m.role}</span>
          {m.parts.map((p, j) => (
            <Part key={j} part={p} />
          ))}
        </li>
      ))}
    </ol>
  );
}

function Part({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return <p className="text">{part.content}</p>;
    case 'tool_call':
      return (
        <div className="tool-call">
          <span className="badge kind-tool">calls {part.name}</span>
          {part.id && <span className="muted small"> {part.id}</span>}
          {part.arguments !== undefined && <Json value={part.arguments} label="arguments" />}
        </div>
      );
    case 'tool_call_response':
      return (
        <details className="tool-call">
          <summary>result for {part.id ?? 'tool call'}</summary>
          {part.response !== undefined && <Json value={part.response} label="response" />}
        </details>
      );
    default:
      return <Json value={part.raw} label="other part" />;
  }
}

function roleClass(role: string): string {
  return ['system', 'user', 'assistant', 'tool'].includes(role) ? role : 'other';
}
