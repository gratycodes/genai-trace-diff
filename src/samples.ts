import agentRuntimeKit from '../fixtures/agent-runtime-kit.otlp.json?raw';
import refundV1 from '../fixtures/refund-v1.otlp.json?raw';
import refundV2Timeout from '../fixtures/refund-v2-timeout.otlp.json?raw';
import refundV2 from '../fixtures/refund-v2.otlp.json?raw';

/** Synthetic sample files bundled with the app. Order matters: the first two are diffed by default. */
export const SAMPLE_FILES: Array<{ name: string; text: string }> = [
  { name: 'refund-v1.otlp.json', text: refundV1 },
  { name: 'refund-v2.otlp.json', text: refundV2 },
  { name: 'refund-v2-timeout.otlp.json', text: refundV2Timeout },
  { name: 'agent-runtime-kit.otlp.json', text: agentRuntimeKit },
];
