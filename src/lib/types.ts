/** A decoded OTLP attribute value. */
export type AttrValue = string | number | boolean | null | AttrValue[] | { [key: string]: AttrValue };

export type Attributes = Record<string, AttrValue>;

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

/** One span, flattened out of the OTLP resourceSpans/scopeSpans nesting. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** Milliseconds since the Unix epoch (microsecond precision kept in the fraction). */
  startMs: number;
  endMs: number;
  attributes: Attributes;
  resource: Attributes;
  events: SpanEvent[];
  status: { code: 'unset' | 'ok' | 'error'; message?: string };
}

export type StepKind = 'agent' | 'model' | 'tool' | 'other';

/** A message part, following the GenAI semantic conventions JSON schema for messages. */
export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id?: string; name: string; arguments?: AttrValue }
  | { type: 'tool_call_response'; id?: string; response?: AttrValue }
  | { type: 'other'; raw: AttrValue };

export interface Message {
  role: string;
  parts: MessagePart[];
  finishReason?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** A span interpreted as one step of an agent run. */
export interface Step {
  span: Span;
  kind: StepKind;
  /** The gen_ai.operation.name, or the span name when absent. */
  operation: string;
  label: string;
  depth: number;
  /** Offset from the start of the trace. */
  offsetMs: number;
  durationMs: number;
  model?: string;
  agentName?: string;
  toolName?: string;
  toolCallId?: string;
  toolArguments?: AttrValue;
  toolResult?: AttrValue;
  usage: Usage;
  costUsd?: number;
  systemInstructions?: Message[];
  inputMessages?: Message[];
  outputMessages?: Message[];
  finishReasons?: string[];
  error?: string;
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** undefined when no span in the trace carries gen_ai.usage.cost_usd. */
  costUsd?: number;
  /** Number of model-call spans that carry a cost, out of modelCalls. */
  pricedModelCalls: number;
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
  errors: number;
}

export interface Trace {
  traceId: string;
  /** Human-readable title: root span name, or the first span's name. */
  title: string;
  serviceName?: string;
  /** Name of the file this trace came from. */
  source: string;
  startMs: number;
  steps: Step[];
  totals: Totals;
}
