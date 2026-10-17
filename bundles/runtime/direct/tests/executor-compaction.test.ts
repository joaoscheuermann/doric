import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMessage, ProviderRequest } from 'llms';

import {
  directServices,
  fakeThreadState,
  projectId,
  promptId,
  runPrompt,
  seedHistory,
  testConfiguration,
  thread,
  threadId,
} from './support/harness.js';

const scope = { projectId, threadId, promptId };

test('repeating manual compaction without new eligible content does not call the model or append events', async () => {
  const state = fakeThreadState();
  const services = directServices({
    configuration: compactionConfiguration(),
    provider: {
      stream: () => {
        assert.fail('no model call for an existing summary');
      },
    },
  });
  await services.activate();
  seedHistory(state, {
    messages: [
      { role: 'user', content: '[Context summary]\n\nExisting summary' },
      { role: 'user', content: 'retained one' },
      { role: 'user', content: 'retained two' },
    ],
  });
  const result = await services.executor(scope).compact({
    thread: thread(),
    session: state.session('retry'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  assert.deepEqual(result, { status: 'refused', reason: 'nothing_to_compact' });
  assert.equal(state.events.length, 0);
  assert.equal(
    ((await state.reader().read('messages')) as unknown[]).length,
    3,
  );
});

const compactionConfiguration = (overrides: Record<string, unknown> = {}) =>
  ({
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: true,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        charBudget: 1000,
        ...overrides,
      },
    },
  }) as ReturnType<typeof testConfiguration>;

const longHistory = (count: number): readonly ProviderMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: `old message ${index} ${'padding '.repeat(25)}`,
  }));

const finishing = (requests: ProviderRequest[]) => ({
  metadata: { id: 'provider', name: 'provider' },
  stream: async function* (request: ProviderRequest) {
    requests.push(request);
    yield {
      type: 'usage' as const,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    yield {
      type: 'response.finished' as const,
      finish: { text: 'done', finishReason: 'stop' as const, toolCalls: [] },
    };
  },
});

void test('a resumed run condenses the old span before its first provider call', async () => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  seedHistory(state, {
    messages: [
      ...longHistory(20),
      { role: 'user' as const, content: 'recent' },
    ],
    checkpoints: { 'old-prompt': 20 },
  });
  const services = directServices({
    configuration: compactionConfiguration(),
    provider: finishing(requests),
  });
  await services.activate();

  const text = await runPrompt(services, state, 'continue');
  assert.equal(text, 'done');

  // The provider saw the summary checkpoint instead of the old span: the
  // last request is the run's own (the first one was the summary's call).
  const seen = requests.at(-1)?.messages ?? [];
  assert.equal(
    seen.some((message) =>
      String(message.content).startsWith('[Context summary]'),
    ),
    true,
  );
  assert.equal(
    seen.some((message) => String(message.content).includes('old message 0')),
    false,
  );
  // The recent tail survives.
  assert.equal(
    seen.some((message) => message.content === 'recent'),
    true,
  );

  // The log carries the bracket with its result.
  const types = state.events.map(
    (event) => (event.event as { type?: string }).type,
  );
  assert.equal(types.includes('compaction.started'), true);
  assert.equal(types.includes('compaction.finished'), true);

  // The stored history holds the rewrite with re-based checkpoints.
  const meta = state.parts().meta as {
    checkpoints: Record<string, number>;
    messageCount: number;
  };
  assert.equal(meta.messageCount, seen.length);
  assert.deepEqual(meta.checkpoints, { 'old-prompt': 2 });

  // The boundary survives the rewrite, but the content it opened is gone:
  // the rewind cuts to the summary and the tail, never the old span.
  const rewind = await services.executor(scope).rewind({
    history: state.reader(),
    promptId: 'old-prompt',
    removedPromptIds: [],
  });
  assert.equal(rewind === undefined, false);
  if (rewind !== undefined) {
    const messages = rewind.parts.messages as ProviderMessage[];
    assert.equal(
      messages.every(
        (message) => !String(message.content).includes('old message 0'),
      ),
      true,
    );
  }
});

void test('a disabled compaction leaves the history untouched', async () => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  seedHistory(state, {
    messages: [
      ...longHistory(20),
      { role: 'user' as const, content: 'recent' },
    ],
  });
  const configuration = compactionConfiguration({ enabled: false });
  const services = directServices({
    configuration,
    provider: finishing(requests),
  });
  await services.activate();

  await runPrompt(services, state, 'continue');
  const types = state.events.map(
    (event) => (event.event as { type?: string }).type,
  );
  assert.equal(types.includes('compaction.started'), false);
  const seen = requests[0]?.messages ?? [];
  assert.equal(
    seen.some((message) => String(message.content).includes('old message 0')),
    true,
  );
});

void test('the on-demand compact refuses an empty history and answers nothing_to_compact', async () => {
  const state = fakeThreadState();
  const services = directServices({
    configuration: compactionConfiguration(),
    provider: { stream: async function* () {} },
  });
  await services.activate();

  const refused = await services.executor(scope).compact({
    thread: thread(),
    session: state.session('compaction-1'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  assert.deepEqual(refused, { status: 'refused', reason: 'missing_history' });

  seedHistory(state, {
    messages: [{ role: 'user' as const, content: 'tiny' }],
  });
  const nothing = await services.executor(scope).compact({
    thread: thread(),
    session: state.session('compaction-2'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  assert.deepEqual(nothing, {
    status: 'refused',
    reason: 'nothing_to_compact',
  });
});

void test('the on-demand compact condenses a big history and records the bracket', async () => {
  const state = fakeThreadState();
  const services = directServices({
    configuration: compactionConfiguration(),
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      stream: async function* () {
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'The conversation asked for an overview and got one.',
            finishReason: 'stop' as const,
            toolCalls: [],
          },
        };
      },
    },
  });
  await services.activate();
  seedHistory(state, {
    messages: [
      ...longHistory(12),
      { role: 'user' as const, content: 'recent' },
    ],
    checkpoints: { early: 6, late: 12 },
  });

  const result = await services.executor(scope).compact({
    thread: thread(),
    session: state.session('compaction-3'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });

  assert.equal(result.status, 'compacted');
  if (result.status === 'compacted') {
    assert.equal(result.condensedMessages, 11);
    assert.equal(result.retainedMessages, 3);
  }
  const messages = (await state.reader().read('messages')) as ProviderMessage[];
  assert.equal(messages.length, 3);
  const finished = state.events
    .map(
      (entry) =>
        entry.event as { type?: string; summary?: string; summaryId?: string },
    )
    .find((event) => event.type === 'compaction.finished');
  assert.equal(finished?.summary, messages[0]?.content);
  assert.ok(finished?.summaryId);
  assert.equal(
    String(messages[0]?.content).startsWith('[Context summary]'),
    true,
  );
  const meta = state.parts().meta as { checkpoints: Record<string, number> };
  assert.deepEqual(meta.checkpoints, { late: 2 });
  const types = state.events.map(
    (event) => (event.event as { type?: string }).type,
  );
  assert.deepEqual(
    types.filter((type) => type?.startsWith('compaction.')),
    ['compaction.started', 'compaction.finished'],
  );
});

void test('a disabled executor refuses the on-demand compact before planning', async () => {
  const state = fakeThreadState();
  const services = directServices({
    configuration: compactionConfiguration({ enabled: false }),
    provider: { stream: async function* () {} },
  });
  await services.activate();
  const refused = await services.executor(scope).compact({
    thread: thread(),
    session: state.session('compaction-4'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  assert.deepEqual(refused, { status: 'refused', reason: 'disabled' });
});
