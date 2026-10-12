import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';

import {
  directServices,
  fakeThreadState,
  projectId,
  promptId,
  runPrompt,
  seedHistory,
  threadId,
} from './support/harness.js';

const scope = { projectId, threadId, promptId };

const answering = (requests: ProviderRequest[] = []) => ({
  metadata: { id: 'provider', name: 'provider' },
  stream: async function* (request: ProviderRequest) {
    requests.push(request);
    yield {
      type: 'response.finished' as const,
      finish: { text: 'done', finishReason: 'stop' as const, toolCalls: [] },
    };
  },
});

const activated = async (requests?: ProviderRequest[]) => {
  const services = directServices({ provider: answering(requests) });
  await services.activate();
  return services;
};

const messages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: `message ${index}`,
  }));

void test('reads only the direct.history/v1 format', async () => {
  const services = await activated();

  assert.deepEqual(await services.executor(scope).formats(), [
    'direct.history/v1',
  ]);
});

void test('records a prompt boundary at the stored message count', async () => {
  const services = await activated();
  const state = fakeThreadState();
  seedHistory(state, { messages: messages(3), checkpoints: { other: 1 } });

  assert.deepEqual(
    await services
      .executor(scope)
      .checkpoint({ history: state.reader(), promptId }),
    {
      format: 'direct.history/v1',
      parts: {
        meta: { checkpoints: { [promptId]: 3, other: 1 }, messageCount: 3 },
      },
    },
  );
});

void test('keeps the boundary a resumed prompt already has', async () => {
  const services = await activated();
  const state = fakeThreadState();
  seedHistory(state, {
    messages: messages(5),
    checkpoints: { [promptId]: 2 },
  });

  const patch = await services
    .executor(scope)
    .checkpoint({ history: state.reader(), promptId });

  assert.deepEqual(patch.parts.meta, {
    checkpoints: { [promptId]: 2 },
    messageCount: 5,
  });
});

void test('records a boundary of zero on a Thread with no history yet', async () => {
  const services = await activated();
  const state = fakeThreadState();

  const patch = await services
    .executor(scope)
    .checkpoint({ history: state.reader(), promptId });

  assert.deepEqual(patch, {
    format: 'direct.history/v1',
    parts: { meta: { checkpoints: { [promptId]: 0 }, messageCount: 0 } },
  });
});

void test('rewinds to the boundary and drops every removed prompt boundary', async () => {
  const services = await activated();
  const state = fakeThreadState();
  const stored = messages(6);
  seedHistory(state, {
    messages: stored,
    checkpoints: { kept: 0, [promptId]: 2, later: 4 },
  });

  assert.deepEqual(
    await services.executor(scope).rewind({
      history: state.reader(),
      promptId,
      removedPromptIds: [promptId, 'later'],
    }),
    {
      format: 'direct.history/v1',
      parts: {
        messages: stored.slice(0, 2),
        meta: { checkpoints: { kept: 0 }, messageCount: 2 },
      },
    },
  );
});

void test('has nothing to rewind for a prompt with no boundary', async () => {
  const services = await activated();
  const state = fakeThreadState();
  seedHistory(state, { messages: messages(2), checkpoints: { other: 0 } });

  assert.equal(
    await services.executor(scope).rewind({
      history: state.reader(),
      promptId,
      removedPromptIds: [promptId],
    }),
    undefined,
  );
});

void test('the next prompt after a rewind continues from the truncated history', async () => {
  const requests: ProviderRequest[] = [];
  const services = await activated(requests);
  const state = fakeThreadState();
  const executor = services.executor(scope);
  state.apply(await executor.checkpoint({ history: state.reader(), promptId }));
  await runPrompt(services, state, 'first');
  const second = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1609';
  state.apply(
    await executor.checkpoint({ history: state.reader(), promptId: second }),
  );
  await runPrompt(services, state, 'second', { id: second });
  const patch = await executor.rewind({
    history: state.reader(),
    promptId: second,
    removedPromptIds: [second],
  });
  assert.ok(patch);
  state.apply(patch);

  await runPrompt(services, state, 'third', {
    id: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf160a',
  });

  assert.deepEqual(requests.at(-1)?.messages.slice(1), [
    { role: 'user', content: '# User request\n\nfirst' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: '# User request\n\nthird' },
  ]);
});

void test('labels each input source with its header', async () => {
  const requests: ProviderRequest[] = [];
  const services = await activated(requests);
  const sources = [
    { kind: 'user' },
    { kind: 'parent', threadId: 't-parent', promptId: 'p-parent' },
    { kind: 'terminal', terminalId: 'term-1', promptId: 'p-term' },
    {
      kind: 'result',
      threadId: 't-child',
      promptId: 'p-child',
      requestPromptId: 'p-request',
    },
  ] as const;

  for (const source of sources) {
    await runPrompt(services, fakeThreadState(), 'body', { source });
  }

  assert.deepEqual(
    requests.map((request) => request.messages.at(-1)?.content),
    [
      '# User request\n\nbody',
      '# Parent instruction from thread t-parent, prompt p-parent\n\nbody',
      '# Background terminal term-1, originating prompt p-term\n\nbody',
      '# Child result from thread t-child, prompt p-child\n\nbody',
    ],
  );
});
