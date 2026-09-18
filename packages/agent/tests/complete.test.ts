import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderFinished } from 'llms';
import { createMessageStorage } from 'messages';

import {
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
} from './fakes.js';

test('complete returns the provider response metadata', async () => {
  const finish: ProviderFinished = {
    ...completeFinish('Final answer.'),
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    reasoning: { summary: 'Short reasoning.' },
  };

  const agent = createAgent({
    provider: createProvider({ complete: () => finish }).provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });
  const response = await agent.complete('Hello.');

  assert.equal(response.text, 'Final answer.');

  assert.equal(response.finishReason, 'stop');

  assert.deepEqual(response.usage, finish.usage);

  assert.deepEqual(response.reasoning, finish.reasoning);

  assert.equal(response.finish.text, 'Final answer.');
});

test('complete forwards configured request controls to the provider', async () => {
  const provider = createProvider({ complete: () => completeFinish('Done.') });

  const definition = {
    name: 'lookup',
    inputSchema: { type: 'object' as const },
    outputSchema: {},
  };

  const agent = createAgent({
    provider: provider.provider,
    tools: createTools({ definitions: [definition] }).storage,
    messages: createMessageStorage(),
    system: 'Follow instructions.',
    model: 'fake-model',
    effort: 'high',
    temperature: 0.2,
    maxOutputTokens: 128,
    flags: { includeUsage: true },
  });

  await agent.complete('Hello.');

  const request = provider.requests[0];

  assert.equal(request?.model, 'fake-model');

  assert.deepEqual(request?.messages, [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Hello.' },
  ]);

  assert.deepEqual(request?.tools, [definition]);

  assert.equal(request?.effort, 'high');

  assert.equal(request?.temperature, 0.2);

  assert.equal(request?.maxOutputTokens, 128);

  assert.deepEqual(request?.flags, { includeUsage: true });
});

test('complete stores conversation messages without persisting the system prompt', async () => {
  const provider = createProvider({ complete: () => completeFinish('Done.') });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: provider.provider,
    tools: createTools().storage,
    messages,
    system: 'Private system.',
    model: 'fake-model',
  });

  await agent.complete('Visible input.');

  assert.equal(provider.requests[0]?.messages[0]?.role, 'system');

  assert.deepEqual(messages.list(), [
    { role: 'user', content: 'Visible input.' },
    { role: 'assistant', content: 'Done.' },
  ]);
});
