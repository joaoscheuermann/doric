import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';

import { checkpoint, rewind } from '../src/host/history.js';
import {
  promptId,
  seedHistory,
  testConfiguration,
  thread,
} from './support/harness.js';
import { routed, scope, sessionId } from './support/router.js';
import {
  callsOf,
  earlier,
  kernelOf,
  scriptedModel,
  seedSession,
} from './support/router-helpers.js';
import { patchOf, plain, wireThread } from './support/router-wire.js';

// `executor/v1`'s history methods through the router (phase 3, slice S51d,
// contract §6, D26, D27): `Compact`, `Checkpoint` and `Rewind` over the
// stored history, against what the kernel answers.

void test('D26 Compact condenses the stored history as the kernel does and answers the same result', async (t) => {
  const configuration = {
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: true,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        charBudget: 1000,
      },
    },
  } as ReturnType<typeof testConfiguration>;
  const history = {
    messages: [
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'user' as const,
        content: `old message ${index} ${'padding '.repeat(25)}`,
      })),
      { role: 'user' as const, content: 'recent' },
    ],
    checkpoints: { early: 6, late: 12 },
  };
  const summary = () =>
    scriptedModel([{ text: 'The conversation asked for an overview.' }]);
  const kernel = kernelOf({ provider: summary().provider, configuration });
  kernel.activate();
  seedHistory(kernel.state, history);
  const expected = await kernel.services.executor(scope).compact({
    thread: thread(),
    session: kernel.state.session('compaction'),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  const host = routed({ provider: summary().provider, configuration });
  t.after(() => host.router.control.stop());
  seedSession(host.session, history);
  await host.activate();

  const answer = await host.executor.compact({
    sessionId,
    thread: wireThread(),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });

  const anonymous = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value).replaceAll(
        /compaction-[0-9a-f-]{36}/g,
        'compaction-id',
      ),
    ) as unknown;
  assert.equal(expected.status, 'compacted');
  assert.deepEqual(
    anonymous({
      status: answer.status,
      summaryId: answer.summaryId,
      condensedMessages: answer.condensedMessages,
      retainedMessages: answer.retainedMessages,
      tokensFreed: answer.tokensFreed,
    }),
    anonymous(expected),
  );
  assert.deepEqual(
    anonymous(host.session.records),
    anonymous(kernel.state.writes),
  );
});

void test('D26 Compact with compaction disabled answers refused disabled and calls no model', async (t) => {
  const configuration = {
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: false,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        charBudget: 1000,
      },
    },
  } as ReturnType<typeof testConfiguration>;
  const host = routed({ provider: scriptedModel([]).provider, configuration });
  t.after(() => host.router.control.stop());
  seedSession(host.session, earlier);
  await host.activate();

  const answer = await host.executor.compact({
    sessionId,
    thread: wireThread(),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });

  assert.deepEqual(
    { status: answer.status, reason: answer.reason },
    { status: 'refused', reason: 'disabled' },
  );
  assert.deepEqual(callsOf(host.calls, ModelsService), []);
});

void test('D27 Checkpoint and Rewind answer, read back, what today’s checkpoint and rewind give for the stored history', async (t) => {
  const stored = {
    messages: [
      ...earlier.messages,
      {
        role: 'user' as const,
        content: '<user-request>\nlater\n</user-request>',
      },
      { role: 'assistant' as const, content: 'later answer' },
    ],
    checkpoints: { 'prompt-0': 0, 'prompt-1': 2 },
  };
  const host = routed({ provider: scriptedModel([]).provider });
  t.after(() => host.router.control.stop());
  seedSession(host.session, stored);
  const reader = {
    format: 'default.history/v1',
    read: async (part: string) => structuredClone(host.session.parts[part]),
  };
  const expectedCheckpoint = await checkpoint({ history: reader, promptId });
  const expectedRewind = await rewind({
    history: reader,
    promptId: 'prompt-1',
    removedPromptIds: ['prompt-1'],
  });
  await host.activate();

  const checkpointed = await patchOf(
    host.executor.checkpoint({ sessionId, promptId }),
  );
  const rewound = await patchOf(
    host.executor.rewind({
      sessionId,
      promptId: 'prompt-1',
      removedPromptIds: ['prompt-1'],
    }),
  );
  const nothing = await patchOf(
    host.executor.rewind({
      sessionId,
      promptId: 'unknown',
      removedPromptIds: [],
    }),
  );

  assert.deepEqual(checkpointed, plain(expectedCheckpoint));
  assert.deepEqual(rewound, plain(expectedRewind));
  assert.equal(nothing, undefined);
});
