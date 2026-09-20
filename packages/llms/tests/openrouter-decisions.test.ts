import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderErrorObject } from '../src/index.js';
import { createOpenRouterProvider, fakeTransport, response } from './fakes.js';

test('evaluates Jev questions through the OpenRouter Decisions API', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        model: 'typesafe/jev-1.13',
        answers: {
          is_urgent: { type: 'noul', noul: 0.93 },
          department: {
            type: 'choice',
            choice: 'billing',
            confidence: 0.82,
            probabilities: {
              billing: 0.82,
              technical: 0.12,
              sales: 0.06,
            },
          },
          frustration: {
            type: 'score',
            score: 1.6,
            confidence: 0.6,
            legend: {
              0: 'Calm',
              1: 'Frustrated',
              2: 'Very angry',
            },
            probabilities: { 0: 0, 1: 0.4, 2: 0.6 },
          },
        },
        usage: { input_tokens: 392, output_tokens: 65 },
      }),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'test-key',
  });
  const questions = {
    is_urgent: {
      type: 'noul',
      instructions: 'Does this message convey urgency?',
      criteria: {
        true: 'Explicitly time-sensitive',
        false: 'No urgency expressed',
      },
    },
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
  } as const;

  const result = await provider.decide({
    model: '~typesafe/jev-latest',
    state: 'Help! My payouts have been failing for 3 days.',
    questions,
  });

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.method, 'POST');
  assert.equal(
    transport.requests[0]?.url,
    'https://openrouter.ai/api/alpha/decisions',
  );
  assert.deepEqual(transport.requests[0]?.headers, {
    authorization: 'Bearer test-key',
    'content-type': 'application/json',
    accept: 'application/json',
  });
  assert.deepEqual(JSON.parse(transport.requests[0]?.body ?? ''), {
    model: '~typesafe/jev-latest',
    state: 'Help! My payouts have been failing for 3 days.',
    questions,
  });

  assert.equal(result.model, 'typesafe/jev-1.13');
  assert.equal(result.answers.is_urgent.noul, 0.93);
  assert.equal(result.answers.department.choice, 'billing');
  assert.equal(result.answers.frustration.score, 1.6);
  assert.deepEqual(result.usage, {
    inputTokens: 392,
    outputTokens: 65,
    totalTokens: undefined,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  });
});

test('uses the configured OpenRouter API base for Jev decisions', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        model: 'typesafe/jev-1.13',
        answers: { relevant: { type: 'noul', noul: 1 } },
      }),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.test/api/v1',
  });

  await provider.decide({
    model: '~typesafe/jev-latest',
    state: { ticket: 'A payment failed.' },
    questions: {
      relevant: {
        type: 'noul',
        instructions: 'Is this ticket about payments?',
      },
    },
  });

  assert.equal(
    transport.requests[0]?.url,
    'https://openrouter.test/api/alpha/decisions',
  );
});

test('rejects malformed Jev answers at the provider boundary', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      responses: [
        response({
          model: 'typesafe/jev-1.13',
          answers: { relevant: { type: 'noul', noul: 'yes' } },
        }),
      ],
    }),
    apiKey: 'test-key',
  });

  await assert.rejects(
    provider.decide({
      model: '~typesafe/jev-latest',
      state: 'A payment failed.',
      questions: {
        relevant: {
          type: 'noul',
          instructions: 'Is this ticket about payments?',
        },
      },
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'malformed_response',
  );
});
