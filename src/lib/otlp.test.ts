import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OtlpParseError, decodeAnyValue, nanosToMs, parseOtlpJson } from './otlp';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');

const minimal = (spans: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }], ...extra }] });

describe('parseOtlpJson', () => {
  it('flattens resourceSpans/scopeSpans and decodes attributes', () => {
    const spans = parseOtlpJson(fixture('agent-runtime-kit.otlp.json'));
    expect(spans).toHaveLength(9);
    const chat = spans.find((s) => s.name === 'chat example-large')!;
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(2400);
    expect(chat.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    expect(chat.resource['service.name']).toBe('support-bot-demo');
    expect(chat.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts JSON Lines (Collector file exporter format)', () => {
    const a = minimal([{ traceId: 'aa', spanId: '01', name: 'a', startTimeUnixNano: '1', endTimeUnixNano: '2' }]);
    const b = minimal([{ traceId: 'bb', spanId: '02', name: 'b', startTimeUnixNano: '1', endTimeUnixNano: '2' }]);
    const spans = parseOtlpJson(`${a}\n${b}\n`);
    expect(spans.map((s) => s.traceId)).toEqual(['aa', 'bb']);
  });

  it('accepts an array of export requests and the legacy instrumentationLibrarySpans key', () => {
    const legacy = {
      resourceSpans: [{ instrumentationLibrarySpans: [{ spans: [{ traceId: 'cc', spanId: '03', name: 'old' }] }] }],
    };
    const spans = parseOtlpJson(JSON.stringify([legacy, JSON.parse(minimal([{ traceId: 'dd', spanId: '04', name: 'new' }]))]));
    expect(spans.map((s) => s.name)).toEqual(['old', 'new']);
  });

  it('converts base64 ids to lowercase hex', () => {
    const [span] = parseOtlpJson(minimal([{ traceId: 'q83v', spanId: 'ASM=', name: 'x' }]));
    expect(span!.traceId).toBe('abcdef');
    expect(span!.spanId).toBe('0123');
  });

  it('decodes status codes in numeric and enum-name form', () => {
    const spans = parseOtlpJson(
      minimal([
        { traceId: 'a', spanId: '1', name: 'x', status: { code: 2, message: 'boom' } },
        { traceId: 'a', spanId: '2', name: 'y', status: { code: 'STATUS_CODE_OK' } },
        { traceId: 'a', spanId: '3', name: 'z' },
      ]),
    );
    expect(spans.map((s) => s.status)).toEqual([{ code: 'error', message: 'boom' }, { code: 'ok' }, { code: 'unset' }]);
  });

  it('rejects empty files, invalid JSON and non-OTLP JSON with a clear error', () => {
    expect(() => parseOtlpJson('  ')).toThrow(OtlpParseError);
    expect(() => parseOtlpJson('{not json')).toThrow(/not valid JSON/);
    expect(() => parseOtlpJson('{"spans": []}')).toThrow(/resourceSpans/);
  });
});

describe('decodeAnyValue', () => {
  it('handles every AnyValue variant', () => {
    expect(decodeAnyValue({ stringValue: 's' })).toBe('s');
    expect(decodeAnyValue({ intValue: '42' })).toBe(42);
    expect(decodeAnyValue({ doubleValue: 0.5 })).toBe(0.5);
    expect(decodeAnyValue({ boolValue: true })).toBe(true);
    expect(decodeAnyValue({ arrayValue: { values: [{ intValue: 1 }, { stringValue: 'b' }] } })).toEqual([1, 'b']);
    expect(decodeAnyValue({ kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } })).toEqual({ k: 'v' });
    expect(decodeAnyValue({ arrayValue: {} })).toEqual([]);
    expect(decodeAnyValue({})).toBeNull();
  });
});

describe('nanosToMs', () => {
  it('keeps microsecond precision from nanosecond strings', () => {
    expect(nanosToMs('1791652838505109053')).toBe(1791652838505.109);
    expect(nanosToMs(2_000_000)).toBe(2);
    expect(nanosToMs(undefined)).toBe(0);
    expect(nanosToMs('12abc')).toBe(0);
  });
});
