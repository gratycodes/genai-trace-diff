// Generates the synthetic OTLP/JSON fixtures in fixtures/.
//
// Everything here is made up: the "support-bot" agent, the orders, the tools and the
// example-* model names (taken from the example price book in
// https://github.com/gratycodes/otel-genai-cost). Costs are computed with that price book's
// formula and stamped as gen_ai.usage.cost_usd, the attribute the otel-genai-cost processor
// writes, so the files look like traces that passed through it.
//
//   node scripts/make-fixtures.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const PRICE_BOOK_VERSION = 'example-2026-10-01';
// USD per 1M tokens, from otel-genai-cost/examples/pricebook.yaml.
const PRICES = {
  'example-large': { input: 3.0, output: 15.0, cacheRead: 0.3 },
  'example-small': { input: 0.15, output: 0.6, cacheRead: 0.075 },
};

const BASE_MS = Date.UTC(2026, 9, 8, 9, 30, 0); // 2026-10-08T09:30:00Z

function hexId(seed, bytes) {
  return createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2);
}

function nanos(ms) {
  return (BigInt(Math.round(ms * 1000)) * 1000n).toString();
}

function anyValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  throw new Error(`unsupported attribute value ${JSON.stringify(v)}`);
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: anyValue(v) }));
}

function cost(model, usage) {
  const p = PRICES[model];
  const cached = usage.cacheRead ?? 0;
  const usd = ((usage.input - cached) * p.input + cached * p.cacheRead + usage.output * p.output) / 1e6;
  return Math.round(usd * 1e9) / 1e9;
}

const text = (content) => ({ type: 'text', content });
const toolCall = (id, name, args) => ({ type: 'tool_call', id, name, arguments: args });
const toolResponse = (id, response) => ({ type: 'tool_call_response', id, response });

/**
 * Build one trace. `steps` are relative to the run start (ms). Model steps carry messages
 * and usage; tool steps carry arguments and results.
 */
function buildRun({ seed, agent, attributes, steps, totalMs }) {
  const traceId = hexId(`${seed}:trace`, 16);
  const rootId = hexId(`${seed}:root`, 8);
  const start = BASE_MS + (seed.length % 7) * 60_000;
  const common = { 'gen_ai.agent.name': agent.name, ...attributes };
  let totalIn = 0;
  let totalOut = 0;

  const spans = steps.map((s, i) => {
    const spanId = hexId(`${seed}:span:${i}`, 8);
    const base = {
      traceId,
      spanId,
      parentSpanId: rootId,
      startTimeUnixNano: nanos(start + s.at),
      endTimeUnixNano: nanos(start + s.at + s.ms),
      status: s.error ? { code: 2, message: s.error } : {},
    };
    if (s.model) {
      totalIn += s.usage.input;
      totalOut += s.usage.output;
      return {
        ...base,
        name: `chat ${s.model}`,
        kind: 3,
        attributes: attrs({
          ...common,
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'example',
          'gen_ai.request.model': s.model,
          'gen_ai.response.model': `${s.model}-2026-09-01`,
          'gen_ai.response.id': `resp_${hexId(`${seed}:resp:${i}`, 6)}`,
          'gen_ai.request.temperature': 0.2,
          'gen_ai.usage.input_tokens': s.usage.input,
          'gen_ai.usage.output_tokens': s.usage.output,
          'gen_ai.usage.cache_read.input_tokens': s.usage.cacheRead,
          'gen_ai.response.finish_reasons': [s.finish],
          'gen_ai.system_instructions': JSON.stringify([text(agent.instructions)]),
          'gen_ai.input.messages': JSON.stringify(s.input),
          'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: s.output, finish_reason: s.finish }]),
          'gen_ai.usage.cost_usd': cost(s.model, s.usage),
          'genaicost.price_book.version': PRICE_BOOK_VERSION,
          'genaicost.price.model': `${s.model}*`,
        }),
      };
    }
    return {
      ...base,
      name: `execute_tool ${s.tool}`,
      kind: 1,
      attributes: attrs({
        ...common,
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': s.tool,
        'gen_ai.tool.type': 'function',
        'gen_ai.tool.call.id': s.callId,
        'gen_ai.tool.description': s.description,
        'gen_ai.tool.call.arguments': JSON.stringify(s.args),
        'gen_ai.tool.call.result': s.result === undefined ? undefined : JSON.stringify(s.result),
        'error.type': s.error ? s.errorType : undefined,
      }),
    };
  });

  const root = {
    traceId,
    spanId: rootId,
    name: `invoke_agent ${agent.name}`,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(start + totalMs),
    attributes: attrs({
      ...common,
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'example',
      'gen_ai.agent.id': agent.id,
      'gen_ai.conversation.id': `conv_${hexId(`${seed}:conv`, 6)}`,
      'gen_ai.usage.input_tokens': totalIn,
      'gen_ai.usage.output_tokens': totalOut,
    }),
    status: {},
  };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs({
            'service.name': 'support-bot',
            'service.version': agent.version,
            'deployment.environment.name': 'staging',
          }),
        },
        scopeSpans: [{ scope: { name: 'support_bot.agent', version: agent.version }, spans: [root, ...spans] }],
      },
    ],
  };
}

const QUESTION = 'Hi, my order A-1001 arrived with the mug cracked. Can I get a refund?';
const userMsg = { role: 'user', parts: [text(QUESTION)] };

const LOOKUP_V1 = { status: 'delivered', days_since_delivery: 3, amount: 42.5, currency: 'USD' };
const LOOKUP_V2 = { ...LOOKUP_V1, items: [{ sku: 'MUG-01', name: 'Stoneware mug', qty: 1 }] };
const POLICY = { refund_window_days: 30, damaged_on_arrival: 'full refund, no return needed' };

// v1: one large model does everything; checks the refund policy with a tool, then asks
// the customer to confirm instead of issuing the refund.
const v1Agent = {
  name: 'support-bot',
  id: 'agent_support_v1',
  version: '1.4.0',
  instructions:
    'You are a support agent for an online homeware store. Look up orders before answering. Check the refund policy before promising a refund. Ask the customer to confirm before taking action.',
};
const v1Final =
  "Sorry the mug arrived cracked. Order A-1001 was delivered 3 days ago, which is inside our 30-day window, and damaged items get a full refund with no return needed. Shall I refund the $42.50 to your original payment method?";
const v1 = buildRun({
  seed: 'refund-v1',
  agent: v1Agent,
  attributes: { feature: 'refund-assistant', 'tenant.id': 'tenant-a' },
  totalMs: 5240,
  steps: [
    {
      at: 12, ms: 1810, model: 'example-large', finish: 'tool_calls',
      usage: { input: 2400, output: 60, cacheRead: 1800 },
      input: [userMsg],
      output: [toolCall('call_1', 'lookup_order', { order_id: 'A-1001' }), toolCall('call_2', 'refund_policy', {})],
    },
    { at: 1840, ms: 212, tool: 'lookup_order', callId: 'call_1', description: 'Look up an order by id', args: { order_id: 'A-1001' }, result: LOOKUP_V1 },
    { at: 1843, ms: 148, tool: 'refund_policy', callId: 'call_2', description: 'Return the refund policy', args: {}, result: POLICY },
    {
      at: 2075, ms: 3140, model: 'example-large', finish: 'stop',
      usage: { input: 2650, output: 64, cacheRead: 2300 },
      input: [
        userMsg,
        { role: 'assistant', parts: [toolCall('call_1', 'lookup_order', { order_id: 'A-1001' }), toolCall('call_2', 'refund_policy', {})] },
        { role: 'tool', parts: [toolResponse('call_1', LOOKUP_V1)] },
        { role: 'tool', parts: [toolResponse('call_2', POLICY)] },
      ],
      output: [text(v1Final)],
    },
  ],
});

// v2: a small model plans and calls tools, the refund policy moved into the system prompt,
// and the agent issues the refund itself. The large model only writes the final reply.
const v2Agent = {
  name: 'support-bot',
  id: 'agent_support_v2',
  version: '2.0.0',
  instructions:
    'You are a support agent for an online homeware store. Refund policy: 30 days from delivery; items damaged on arrival get a full refund with no return. Look up orders (with items) before answering. You may issue refunds up to $100 without asking.',
};
const v2Final =
  "Sorry the mug arrived cracked. I've refunded the full $42.50 for order A-1001 (refund rf_9f2c41); it should reach your card in 3–5 business days. No need to send the mug back.";
const refundArgs = { order_id: 'A-1001', amount: 42.5, reason: 'damaged_on_arrival' };

function v2Run(seed, { refundFails }) {
  const lookupCall = toolCall('call_1', 'lookup_order', { order_id: 'A-1001', include: ['items'] });
  const refundCall = toolCall('call_2', 'issue_refund', refundArgs);
  const base = [
    userMsg,
    { role: 'assistant', parts: [lookupCall] },
    { role: 'tool', parts: [toolResponse('call_1', LOOKUP_V2)] },
  ];
  const steps = [
    {
      at: 10, ms: 620, model: 'example-small', finish: 'tool_calls',
      usage: { input: 1900, output: 38 },
      input: [userMsg],
      output: [lookupCall],
    },
    { at: 645, ms: 205, tool: 'lookup_order', callId: 'call_1', description: 'Look up an order by id', args: lookupCall.arguments, result: LOOKUP_V2 },
    {
      at: 868, ms: 590, model: 'example-small', finish: 'tool_calls',
      usage: { input: 2150, output: 41 },
      input: base,
      output: [refundCall],
    },
  ];
  if (!refundFails) {
    const result = { refund_id: 'rf_9f2c41', status: 'pending', eta_business_days: '3-5' };
    steps.push(
      { at: 1475, ms: 380, tool: 'issue_refund', callId: 'call_2', description: 'Refund an order to the original payment method', args: refundArgs, result },
      {
        at: 1872, ms: 1590, model: 'example-large', finish: 'stop',
        usage: { input: 2600, output: 58, cacheRead: 1800 },
        input: [...base, { role: 'assistant', parts: [refundCall] }, { role: 'tool', parts: [toolResponse('call_2', result)] }],
        output: [text(v2Final)],
      },
    );
    return buildRun({ seed, agent: v2Agent, attributes: { feature: 'refund-assistant', 'tenant.id': 'tenant-a' }, steps, totalMs: 3490 });
  }
  const err = { error: 'payments API timed out after 5000 ms' };
  const failText =
    "Sorry the mug arrived cracked. Order A-1001 qualifies for a full $42.50 refund, but our payments system didn't respond just now. I've flagged it for the team and you'll get an email once it's processed.";
  steps.push(
    { at: 1475, ms: 5004, tool: 'issue_refund', callId: 'call_2', description: 'Refund an order to the original payment method', args: refundArgs, error: 'payments API timed out after 5000 ms', errorType: 'timeout' },
    {
      at: 6500, ms: 1720, model: 'example-large', finish: 'stop',
      usage: { input: 2610, output: 66, cacheRead: 1800 },
      input: [...base, { role: 'assistant', parts: [refundCall] }, { role: 'tool', parts: [toolResponse('call_2', err)] }],
      output: [text(failText)],
    },
  );
  return buildRun({ seed, agent: v2Agent, attributes: { feature: 'refund-assistant', 'tenant.id': 'tenant-a' }, steps, totalMs: 8250 });
}

const files = {
  'fixtures/refund-v1.otlp.json': v1,
  'fixtures/refund-v2.otlp.json': v2Run('refund-v2', { refundFails: false }),
  'fixtures/refund-v2-timeout.otlp.json': v2Run('refund-v2-timeout', { refundFails: true }),
};
for (const [path, doc] of Object.entries(files)) {
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${path}`);
}
