import { buildTraces } from './genai';
import { parseOtlpJson } from './otlp';
import type { Trace } from './types';

/** Parse one file's text into traces. Throws OtlpParseError on malformed input. */
export function loadTraces(text: string, source: string): Trace[] {
  return buildTraces(parseOtlpJson(text), source);
}
