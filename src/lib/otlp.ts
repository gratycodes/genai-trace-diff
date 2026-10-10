import type { AttrValue, Attributes, Span, SpanEvent } from './types';

/**
 * Parse an OTLP/JSON trace export into flat spans.
 *
 * Accepts what the OTLP file exporter, the Collector's file exporter and the OTLP/HTTP
 * JSON encoding produce:
 *  - a single ExportTraceServiceRequest object ({"resourceSpans": [...]}),
 *  - an array of those objects,
 *  - JSON Lines, one object per line (the Collector file exporter's default format).
 * The legacy "instrumentationLibrarySpans" key is accepted as an alias of "scopeSpans".
 */
export function parseOtlpJson(text: string): Span[] {
  const docs = parseDocuments(text);
  const spans: Span[] = [];
  for (const doc of docs) {
    if (!isObject(doc) || !Array.isArray(doc.resourceSpans)) {
      throw new OtlpParseError('expected an OTLP/JSON object with a "resourceSpans" array');
    }
    for (const rs of doc.resourceSpans) {
      if (!isObject(rs)) continue;
      const resource = decodeAttributes(isObject(rs.resource) ? rs.resource.attributes : undefined);
      const scopes = (rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) as unknown;
      if (!Array.isArray(scopes)) continue;
      for (const ss of scopes) {
        if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
        for (const raw of ss.spans) {
          if (isObject(raw)) spans.push(decodeSpan(raw, resource));
        }
      }
    }
  }
  return spans;
}

export class OtlpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpParseError';
  }
}

function parseDocuments(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new OtlpParseError('the file is empty');
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    // Fall back to JSON Lines.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) throw new OtlpParseError(`not valid JSON: ${(err as Error).message}`);
    return lines.map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (lineErr) {
        throw new OtlpParseError(`line ${i + 1} is not valid JSON: ${(lineErr as Error).message}`);
      }
    });
  }
}

function decodeSpan(raw: Record<string, unknown>, resource: Attributes): Span {
  const parent = typeof raw.parentSpanId === 'string' && raw.parentSpanId !== '' ? normaliseId(raw.parentSpanId) : undefined;
  const events: SpanEvent[] = Array.isArray(raw.events)
    ? raw.events.filter(isObject).map((e) => ({
        name: String(e.name ?? ''),
        timeMs: nanosToMs(e.timeUnixNano),
        attributes: decodeAttributes(e.attributes),
      }))
    : [];
  return {
    traceId: normaliseId(String(raw.traceId ?? '')),
    spanId: normaliseId(String(raw.spanId ?? '')),
    parentSpanId: parent,
    name: String(raw.name ?? ''),
    startMs: nanosToMs(raw.startTimeUnixNano),
    endMs: nanosToMs(raw.endTimeUnixNano),
    attributes: decodeAttributes(raw.attributes),
    resource,
    events,
    status: decodeStatus(raw.status),
  };
}

/** OTLP/JSON ids are hex strings; some exporters emit base64 (the protobuf JSON default). */
function normaliseId(id: string): string {
  if (/^[0-9a-fA-F]*$/.test(id)) return id.toLowerCase();
  try {
    const bin = atob(id);
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return id;
  }
}

function decodeStatus(raw: unknown): Span['status'] {
  if (!isObject(raw)) return { code: 'unset' };
  const code = raw.code;
  const message = typeof raw.message === 'string' && raw.message !== '' ? raw.message : undefined;
  if (code === 2 || code === 'STATUS_CODE_ERROR') return { code: 'error', message };
  if (code === 1 || code === 'STATUS_CODE_OK') return { code: 'ok', message };
  return { code: 'unset', message };
}

/**
 * Unix nanoseconds (a decimal string in OTLP/JSON) to epoch milliseconds.
 * Parsed via BigInt so the microsecond part survives; doubles cannot hold full nanoseconds.
 */
export function nanosToMs(value: unknown): number {
  if (typeof value === 'number') return value / 1e6;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  return Number(BigInt(value) / 1000n) / 1000;
}

export function decodeAttributes(raw: unknown): Attributes {
  const out: Attributes = {};
  if (!Array.isArray(raw)) return out;
  for (const kv of raw) {
    if (isObject(kv) && typeof kv.key === 'string') out[kv.key] = decodeAnyValue(kv.value);
  }
  return out;
}

/** Decode an OTLP AnyValue ({"stringValue": "..."} and friends). */
export function decodeAnyValue(v: unknown): AttrValue {
  if (!isObject(v)) return null;
  if ('stringValue' in v) return String(v.stringValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('bytesValue' in v) return String(v.bytesValue);
  if ('arrayValue' in v) {
    const values = isObject(v.arrayValue) && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : [];
    return values.map(decodeAnyValue);
  }
  if ('kvlistValue' in v) {
    const values = isObject(v.kvlistValue) ? v.kvlistValue.values : undefined;
    return decodeAttributes(values);
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
