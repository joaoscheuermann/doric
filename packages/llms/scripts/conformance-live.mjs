import assert from 'node:assert/strict';

import pino from 'pino';
import { z } from 'zod';

import {
  createFetchTransport,
  createUnifiedProvider,
  ProviderErrorObject,
} from '../dist/index.js';

const acknowledgement = '--yes-paid-conformance';
const budgetUsd = 5;
const maxCallsPerModel = 5;
const maxInputTokensPerCall = 4096;
const maxOutputTokens = 1024;

const logger = pino(
  {
    base: { component: 'llms-conformance' },
    level: process.env.LLMS_CONFORMANCE_LOG_LEVEL?.trim() || 'debug',
    redact: {
      paths: [
        'apiKey',
        'authorization',
        'token',
        '*.apiKey',
        '*.authorization',
      ],
      censor: '[redacted]',
    },
  },
  pino.destination({ dest: 2, sync: true }),
);

const representatives = [
  ['OpenAI', 'openai/gpt-5.6-luna'],
  ['Anthropic', 'anthropic/claude-sonnet-5'],
  ['Gemini', 'google/gemini-3.5-flash-lite'],
  ['Gemma', 'google/gemma-4-26b-a4b-it'],
  ['DeepSeek', 'deepseek/deepseek-v4-flash-0731'],
  ['Kimi', 'moonshotai/kimi-k2.7-code'],
  ['Mistral', 'mistralai/mistral-small-2603'],
  ['Qwen', 'qwen/qwen3.7-flash'],
  ['Llama', 'meta-llama/llama-4-scout'],
  ['xAI', 'x-ai/grok-4.3'],
  ['Z.AI', 'z-ai/glm-5.2'],
  ['Cohere', 'cohere/command-r-08-2024'],
  ['MiniMax', 'minimax/minimax-m3'],
];
const toolMessages = [{ role: 'user', content: 'Call add with 2 and 2.' }];

const addTools = [
  {
    name: 'add',
    description: 'Add two integers.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'integer' },
        right: { type: 'integer' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    outputSchema: { type: 'integer' },
    strict: true,
  },
];

if (!process.argv.includes(acknowledgement)) {
  throw new Error(`refusing paid execution without ${acknowledgement}`);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();

if (!apiKey) {
  throw new Error('OPENROUTER_API_KEY is required');
}

const provider = createUnifiedProvider({
  transport: createFetchTransport(),
  apiKey,
  logger,
});
const catalog = await provider.models();
const models = new Map(catalog.map((model) => [model.id, model]));

for (const [, id] of representatives) {
  if (!models.has(id)) {
    throw new Error(`representative model is missing: ${id}`);
  }
}

const estimatedWorstCaseUsd = representatives.reduce(
  (total, [, id]) => total + worstCaseCost(models.get(id)),
  0,
);

if (
  !Number.isFinite(estimatedWorstCaseUsd) ||
  estimatedWorstCaseUsd > budgetUsd
) {
  throw new Error(
    `estimated worst-case cost $${estimatedWorstCaseUsd.toFixed(4)} exceeds $${budgetUsd.toFixed(2)} budget`,
  );
}

logger.info(
  {
    budgetUsd,
    estimatedWorstCaseUsd,
    representativeCount: representatives.length,
  },
  'live conformance started',
);

const results = [];

for (const [lab, model] of representatives) {
  const startedAt = Date.now();
  let stage = 'structured_output';
  const supportedParameters = modelParameters(models.get(model));

  logger.info(
    {
      lab,
      model,
      structuredStrategy: strategy(supportedParameters),
      supportedParameters,
    },
    'model conformance started',
  );

  try {
    await runStage(lab, model, stage, () => structuredCase(model));

    stage = 'tool_call';

    const called = await runStage(lab, model, stage, () => toolCallCase(model));

    stage = 'tool_replay';

    await runStage(lab, model, stage, () => toolReplayCase(model, called));

    const durationMs = Date.now() - startedAt;

    logger.info({ lab, model, durationMs }, 'model conformance completed');

    results.push({ lab, model, ok: true, durationMs });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const details = errorDetails(error);

    logger.error(
      { lab, model, stage, durationMs, ...details },
      'model conformance failed',
    );

    results.push({
      lab,
      model,
      ok: false,
      stage,
      durationMs,
      ...details,
    });
  }
}

const ok = results.every((result) => result.ok);

logger.info({ ok }, 'live conformance completed');

process.stdout.write(
  `${JSON.stringify({ ok, budgetUsd, estimatedWorstCaseUsd, results }, null, 2)}\n`,
);

if (!ok) {
  process.exitCode = 1;
}

async function runStage(lab, model, stage, execute) {
  const startedAt = Date.now();

  logger.info({ lab, model, stage }, 'conformance stage started');

  const result = await execute();

  logger.info(
    { lab, model, stage, durationMs: Date.now() - startedAt },
    'conformance stage completed',
  );

  return result;
}

async function structuredCase(model) {
  const finish = await provider.complete({
    model,
    messages: [{ role: 'user', content: 'Add 2 and 2.' }],
    schema: z.object({ answer: z.literal('4') }).strict(),
    maxOutputTokens,
  });

  assert.deepEqual(finish.structured, { answer: '4' });
}

async function toolCallCase(model) {
  const called = await provider.complete({
    model,
    messages: toolMessages,
    tools: addTools,
    parallelToolCalls: false,
    maxOutputTokens,
  });

  assert.equal(called.toolCalls.length, 1);

  assert.equal(called.toolCalls[0]?.name, 'add');

  assert.deepEqual(JSON.parse(called.toolCalls[0]?.arguments ?? ''), {
    left: 2,
    right: 2,
  });

  return called;
}

async function toolReplayCase(model, called) {
  const answered = await provider.complete({
    model,
    messages: [
      ...toolMessages,
      {
        role: 'assistant',
        content: called.text,
        toolCalls: called.toolCalls,
        ...(called.replay === undefined ? {} : { replay: called.replay }),
      },
      { role: 'tool', toolCallId: called.toolCalls[0].id, content: '4' },
    ],
    tools: addTools,
    parallelToolCalls: false,
    maxOutputTokens,
  });

  assert.equal(answered.toolCalls.length, 0);

  assert.match(answered.text, /\b4\b/u);
}

function modelParameters(model) {
  const raw = model?.raw;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  const parameters = raw.supported_parameters;

  return Array.isArray(parameters)
    ? parameters.filter((value) => typeof value === 'string').sort()
    : [];
}

function strategy(parameters) {
  if (parameters.includes('structured_outputs')) {
    return 'json_schema';
  }

  if (parameters.includes('response_format')) {
    return 'json_object';
  }

  return 'prompt';
}

function errorDetails(error) {
  if (!(error instanceof ProviderErrorObject)) {
    return {
      error: error instanceof Error ? error.message : 'unknown failure',
    };
  }

  return {
    error: error.message,
    provider: error.data.provider,
    code: error.data.code,
    ...(error.data.status === undefined ? {} : { status: error.data.status }),
    ...(error.data.retryable === undefined
      ? {}
      : { retryable: error.data.retryable }),
    ...(error.data.diagnostic === undefined
      ? {}
      : { diagnostic: error.data.diagnostic }),
  };
}

function worstCaseCost(model) {
  const raw = model?.raw;

  const pricing =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.pricing
      : undefined;

  if (
    pricing === null ||
    typeof pricing !== 'object' ||
    Array.isArray(pricing)
  ) {
    return Number.NaN;
  }

  const input = Number(pricing.prompt);
  const output = Number(pricing.completion);

  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return Number.NaN;
  }

  return (
    maxCallsPerModel *
    (maxInputTokensPerCall * input + maxOutputTokens * output)
  );
}
