// `ThreadsService` through the router (phase 3, S60d, contract s60 §3.6, §6
// R0, R-thr, R-thr-events, P1, P2, M1/M2, Q8): each RPC runs today's
// `/threads` route body over the routed ports and answers the route's body
// under its wrapper, or ends with the route's refusal (reason = today's code,
// message = today's message, gRPC code by §5, the queued edit's
// `invalid_prompt` an `INVALID_ARGUMENT` by its row, Q2). `ListEvents` cuts the
// log under 3 MiB with `nextAfterSequence` (D6, Q7); `DeleteThread` of an agent
// Thread (`forbidden`) answers OK as today's 204 (Q8).

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { type JsonValue, toBinary } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { encode, notFoundError } from 'runtime/contracts';

import {
  CompactResponseSchema,
  CreateBranchResponseSchema,
  CreateTerminalResponseSchema,
  DeleteQueuedPromptResponseSchema,
  DeleteThreadResponseSchema,
  GetGitResponseSchema,
  GetQueuedPromptResponseSchema,
  GetQueueResponseSchema,
  GetThreadResponseSchema,
  GetUsageResponseSchema,
  InterruptResponseSchema,
  ListBranchesResponseSchema,
  ListEventsResponseSchema,
  PromptResponseSchema,
  ResumeQueueResponseSchema,
  ResumeResponseSchema,
  RewindResponseSchema,
  SteerResponseSchema,
  TerminateThreadResponseSchema,
  UpdateQueuedPromptResponseSchema,
  UpdateThreadResponseSchema,
} from '../src/contracts/gen/doric/api/threads/v1/threads_pb.js';
import type { Fakes } from './support/host.js';
import { type Harness, harness } from './support/router.js';
import { routerFakes } from './support/router-fakes.js';
import {
  assertMessage,
  first,
  promptId,
  type Refusal,
  refusalOf,
  thread,
  threadEvent,
  threadId,
  workspaceFakes,
} from './support/router-fixtures.js';
import {
  assertRefusalParity,
  assertSuccessParity,
  type Route,
  routed,
} from './support/router-parity.js';

const refused = (reason: string, message: string, code: Code): Refusal => ({
  reason,
  message,
  code,
});

const notActive = refused(
  'unavailable',
  'transport is not active.',
  Code.Unavailable,
);
const threadMissing = refused(
  'thread_not_found',
  notFoundError('thread').message,
  Code.NotFound,
);

const requestsOf = (h: Harness, method: string): JsonValue[] =>
  h.calls.filter((call) => call.method === method).map((call) => call.request);

const served = (t: TestContext, fakes: Fakes = workspaceFakes) =>
  routed(t, fakes);

/** `workspaceFakes` with `threads.<member>` replaced. */
const threadsAnswering = (member: string, answer: unknown): Fakes => ({
  ...workspaceFakes,
  threads: { ...workspaceFakes.threads, [member]: answer },
});

/** One valid call of every `ThreadsService` method. */
const everyMethod = (
  h: Harness,
): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['GetThread', () => h.threads().getThread({ threadId })],
  ['UpdateThread', () => h.threads().updateThread({ threadId, name: 'x' })],
  ['GetGit', () => h.threads().getGit({ threadId })],
  ['ListBranches', () => h.threads().listBranches({ threadId })],
  [
    'CreateBranch',
    () =>
      h.threads().createBranch({ threadId, branch: 'main', cwd: '/workspace' }),
  ],
  ['Prompt', () => h.threads().prompt({ threadId, prompt: 'Hello' })],
  ['Steer', () => h.threads().steer({ threadId, prompt: 'Change', promptId })],
  ['Resume', () => h.threads().resume({ threadId, promptId })],
  ['Rewind', () => h.threads().rewind({ threadId, promptId, prompt: 'Again' })],
  ['Compact', () => h.threads().compact({ threadId })],
  ['Interrupt', () => h.threads().interrupt({ threadId, promptId })],
  ['ListEvents', () => h.threads().listEvents({ threadId })],
  ['GetUsage', () => h.threads().getUsage({ threadId })],
  ['GetQueue', () => h.threads().getQueue({ threadId })],
  ['ResumeQueue', () => h.threads().resumeQueue({ threadId })],
  [
    'GetQueuedPrompt',
    () => h.threads().getQueuedPrompt({ threadId, promptId }),
  ],
  [
    'UpdateQueuedPrompt',
    () =>
      h
        .threads()
        .updateQueuedPrompt({ threadId, promptId, text: 'x', revision: 1 }),
  ],
  [
    'DeleteQueuedPrompt',
    () => h.threads().deleteQueuedPrompt({ threadId, promptId }),
  ],
  ['CreateTerminal', () => h.threads().createTerminal({ threadId })],
  ['TerminateThread', () => h.threads().terminateThread({ threadId })],
  ['DeleteThread', () => h.threads().deleteThread({ threadId })],
  ['Watch', () => first(h.threads().watch({ threadId }))],
];

// R0 ------------------------------------------------------------------------

void test('R0: before activate every ThreadsService method answers UNAVAILABLE unavailable', async (t) => {
  const h = harness({
    fakes: (record) => routerFakes(record, workspaceFakes),
  });

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  for (const [name, call] of everyMethod(h)) {
    assert.deepEqual(await refusalOf(call()), notActive, name);
  }
  assert.deepEqual(h.calls, []);
});

void test('R0: after deactivate every ThreadsService method answers unavailable', async (t) => {
  const h = await served(t);

  await h.host.deactivate();
  for (const [name, call] of everyMethod(h)) {
    assert.deepEqual(await refusalOf(call()), notActive, name);
  }
  assert.deepEqual(h.calls, []);
});

// R-thr ------------------------------------------------------------------------

void test("R-thr: UpdateThread renames, moves the cwd and sets the execution in one call, in today's order", async (t) => {
  const h = await served(t);
  const response = await h.threads().updateThread({
    threadId,
    name: ' Renamed ',
    cwd: '/workspace/sub',
    providerId: 'openai',
    model: 'gpt-5',
    effort: 'high',
  });

  assertMessage(UpdateThreadResponseSchema, response, { thread });
  assert.deepEqual(
    h.calls.map(({ method }) => method),
    [
      'threads.renameThread',
      'threads.setThreadCwd',
      'threads.setThreadExecution',
    ],
  );
  assert.deepEqual(requestsOf(h, 'threads.renameThread'), [
    { id: threadId, name: 'Renamed' },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.setThreadCwd'), [
    { id: threadId, cwd: '/workspace/sub' },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.setThreadExecution'), [
    { id: threadId, providerId: 'openai', model: 'gpt-5', effort: 'high' },
  ]);
});

void test('R-thr: the outcome RPCs pass their requests to runtime.threads/v1 and answer their wrappers', async (t) => {
  const h = await served(t);

  assertMessage(
    PromptResponseSchema,
    await h.threads().prompt({ threadId, prompt: 'Hello' }),
    { promptId },
  );
  assertMessage(
    SteerResponseSchema,
    await h
      .threads()
      .steer({ threadId, prompt: 'Change', promptId, interrupt: true }),
    { status: 'steered', promptId },
  );
  assertMessage(
    ResumeResponseSchema,
    await h.threads().resume({ threadId, promptId }),
    { thread },
  );
  assertMessage(
    RewindResponseSchema,
    await h.threads().rewind({ threadId, promptId, prompt: 'Again' }),
    { promptId },
  );
  assertMessage(
    InterruptResponseSchema,
    await h.threads().interrupt({ threadId, promptId }),
    { status: 'interrupted' },
  );
  assert.deepEqual(requestsOf(h, 'threads.prompt'), [
    { id: threadId, prompt: 'Hello' },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.steer'), [
    { id: threadId, prompt: 'Change', promptId, interrupt: true },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.resume'), [
    { id: threadId, promptId },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.rewind'), [
    { id: threadId, promptId, prompt: 'Again' },
  ]);
  assert.deepEqual(requestsOf(h, 'threads.pause'), [
    { id: threadId, promptId },
  ]);
});

void test('R-thr: Compact answers the compaction; a failed one is compaction_failed UNAVAILABLE', async (t) => {
  const h = await served(t);

  assertMessage(
    CompactResponseSchema,
    await h.threads().compact({ threadId }),
    {
      status: 'compacted',
      condensedMessages: 4,
      retainedMessages: 2,
      tokensFreed: 100,
    },
  );
  await assertRefusalParity(
    t,
    threadsAnswering('compact', () => ({
      status: 'failed',
      code: 'summarizer_failed',
    })),
    [`/threads/${threadId}/compact`, 'POST'],
    (other) => other.threads().compact({ threadId }),
    'compact failed',
  );
});

void test('R-thr: GetGit and ListBranches answer {status, value}; CreateBranch switches and answers {branches}', async (t) => {
  const h = await served(t);

  assertMessage(GetGitResponseSchema, await h.threads().getGit({ threadId }), {
    status: 'ready',
    value: { repo: false },
  });
  assertMessage(
    ListBranchesResponseSchema,
    await h.threads().listBranches({ threadId }),
    { status: 'ready', value: { branches: [] } },
  );
  assertMessage(
    CreateBranchResponseSchema,
    await h
      .threads()
      .createBranch({ threadId, branch: 'feature', cwd: '/workspace' }),
    { branches: { branches: [] } },
  );
  assert.deepEqual(requestsOf(h, 'git.status'), [{ threadId }]);
  assert.deepEqual(requestsOf(h, 'git.switchBranch'), [
    { threadId, branch: 'feature', cwd: '/workspace' },
  ]);
});

void test('R-thr: GetUsage, GetQueue, ResumeQueue, the queued prompt RPCs and TerminateThread answer their wrappers', async (t) => {
  const h = await served(t);

  assert.ok((await h.threads().getUsage({ threadId })).threadUsage);
  assert.equal(
    (await h.threads().getQueue({ threadId })).threadQueue?.revision,
    1,
  );
  assertMessage(
    ResumeQueueResponseSchema,
    await h.threads().resumeQueue({ threadId }),
    { thread },
  );
  assertMessage(
    GetQueuedPromptResponseSchema,
    await h.threads().getQueuedPrompt({ threadId, promptId }),
    {
      queuedPrompt: { promptId, text: 'Queued', revision: 1, editable: true },
    },
  );
  assertMessage(
    UpdateQueuedPromptResponseSchema,
    await h
      .threads()
      .updateQueuedPrompt({ threadId, promptId, text: 'Edited', revision: 1 }),
    {
      queuedPrompt: { promptId, text: 'Edited', revision: 2, editable: true },
    },
  );
  assertMessage(
    DeleteQueuedPromptResponseSchema,
    await h.threads().deleteQueuedPrompt({ threadId, promptId }),
    {},
  );
  assertMessage(
    TerminateThreadResponseSchema,
    await h.threads().terminateThread({ threadId }),
    { thread: { ...thread, state: 'cancelled' } },
  );
  assert.deepEqual(requestsOf(h, 'threads.editQueued'), [
    { id: threadId, promptId, text: 'Edited', revision: 1 },
  ]);
  assert.deepEqual(requestsOf(h, 'usage.thread'), [{ threadId }]);
});

void test('R-thr: CreateTerminal opens a terminal for the Thread with the size given', async (t) => {
  const h = await served(t);
  const response = await h
    .threads()
    .createTerminal({ threadId, cols: 100, rows: 40 });

  assertMessage(CreateTerminalResponseSchema, response, {
    terminalSession: workspaceFakes.terminal.create(),
  });
  assert.deepEqual(requestsOf(h, 'terminal.create'), [
    { threadId, cols: 100, rows: 40 },
  ]);
});

void test('R-thr/Q8: DeleteThread answers {} for deleted and for an agent Thread (forbidden); active and missing are refused', async (t) => {
  for (const result of ['deleted', 'forbidden'] as const) {
    const h = await served(
      t,
      threadsAnswering('deleteThread', () => result),
    );

    assertMessage(
      DeleteThreadResponseSchema,
      await h.threads().deleteThread({ threadId }),
      {},
      result,
    );
  }

  const missing = await served(
    t,
    threadsAnswering('deleteThread', () => 'missing'),
  );

  assert.deepEqual(
    await refusalOf(missing.threads().deleteThread({ threadId })),
    threadMissing,
  );
  await assertRefusalParity(
    t,
    threadsAnswering('deleteThread', () => 'active'),
    [`/threads/${threadId}`, 'DELETE'],
    (h) => h.threads().deleteThread({ threadId }),
    'deleteThread active',
  );
});

// R-thr-events: ListEvents cut under 3 MiB ---------------------------------------

const MAX = 3 * 1024 * 1024;

const logSize = (
  events: readonly unknown[],
  lastSequence: number,
  nextAfterSequence?: number,
) =>
  toBinary(
    ListEventsResponseSchema,
    encode(ListEventsResponseSchema, {
      threadEventLog: { events, lastSequence },
      ...(nextAfterSequence === undefined ? {} : { nextAfterSequence }),
    }),
  ).length;

void test('R-thr-events: ListEvents keeps the longest prefix under 3 MiB and sets nextAfterSequence to its last sequence', async (t) => {
  const events = Array.from({ length: 56 }, (_, index) =>
    threadEvent(index + 1, 60 * 1024),
  );

  assert.ok(logSize(events, 56) > MAX, 'the log is over 3 MiB');
  const h = await served(
    t,
    threadsAnswering('threadEvents', () => ({ events, lastSequence: 56 })),
  );
  const response = await h.threads().listEvents({ threadId, afterSequence: 0 });
  const kept = response.threadEventLog?.events.length ?? 0;

  assert.ok(kept >= 1 && kept < events.length, `${kept}`);
  assert.deepEqual(
    response.threadEventLog?.events.map(({ sequence }) => sequence),
    events.slice(0, kept).map(({ sequence }) => sequence),
  );
  assert.equal(response.threadEventLog?.lastSequence, 56);
  assert.equal(response.nextAfterSequence, kept);
  assert.ok(logSize(events.slice(0, kept), 56, kept) < MAX);
  assert.ok(
    logSize(events.slice(0, kept + 1), 56, kept + 1) >= MAX,
    'one more event would fit',
  );
  assert.deepEqual(requestsOf(h, 'threads.threadEvents'), [{ id: threadId }]);
});

void test('R-thr-events: an uncut log has no nextAfterSequence; afterSequence is passed', async (t) => {
  const h = await served(t);

  assertMessage(
    ListEventsResponseSchema,
    await h.threads().listEvents({ threadId, afterSequence: 1 }),
    {
      threadEventLog: {
        events: [threadEvent(1), threadEvent(2)],
        lastSequence: 2,
      },
    },
  );
  assert.deepEqual(requestsOf(h, 'threads.threadEvents'), [
    { id: threadId, afterSequence: 1 },
  ]);
});

void test('S62b 17: a runtime page cut before lastSequence (under 3 MiB) answers nextAfterSequence = its last sequence', async (t) => {
  const h = await served(
    t,
    threadsAnswering('threadEvents', () => ({
      events: [threadEvent(3), threadEvent(4)],
      lastSequence: 9,
    })),
  );

  assertMessage(
    ListEventsResponseSchema,
    await h.threads().listEvents({ threadId, afterSequence: 2 }),
    {
      threadEventLog: {
        events: [threadEvent(3), threadEvent(4)],
        lastSequence: 9,
      },
      nextAfterSequence: 4,
    },
    'the cut page and its next cursor',
  );
  assert.deepEqual(requestsOf(h, 'threads.threadEvents'), [
    { id: threadId, afterSequence: 2 },
  ]);
});

void test('S62b 17: an empty runtime page answers no nextAfterSequence', async (t) => {
  const h = await served(
    t,
    threadsAnswering('threadEvents', () => ({ events: [], lastSequence: 9 })),
  );

  assertMessage(
    ListEventsResponseSchema,
    await h.threads().listEvents({ threadId, afterSequence: 9 }),
    { threadEventLog: { events: [], lastSequence: 9 } },
    'an empty page without a next cursor',
  );
});

void test('R-thr-events/Q3: a log runtime refuses as limit_exceeded passes through unchanged', async (t) => {
  const h = await served(
    t,
    threadsAnswering('threadEvents', () => {
      throw new ContractError('limit_exceeded', 'The answer is too large.');
    }),
  );
  const refusal = await refusalOf(h.threads().listEvents({ threadId }));

  assert.equal(refusal.reason, 'limit_exceeded');
});

// P1 / P2 ----------------------------------------------------------------------------

/** The cases of `rest-errors.test.ts` for the Thread routes, plus the outcomes of §3.6 it does not list. */
const refusalCases = (): readonly (readonly [
  string,
  Fakes,
  Route,
  (h: Harness) => Promise<unknown>,
  Code?,
])[] => {
  const undefinedOf = (member: string) =>
    threadsAnswering(member, () => undefined);

  return [
    [
      'thread undefined',
      undefinedOf('thread'),
      [`/threads/${threadId}`],
      (h) => h.threads().getThread({ threadId }),
    ],
    [
      'renameThread undefined',
      undefinedOf('renameThread'),
      [`/threads/${threadId}`, 'PATCH', { name: 'Name' }],
      (h) => h.threads().updateThread({ threadId, name: 'Name' }),
    ],
    [
      'terminateThread undefined',
      undefinedOf('terminateThread'),
      [`/threads/${threadId}/terminate`, 'POST'],
      (h) => h.threads().terminateThread({ threadId }),
    ],
    [
      'queue undefined',
      undefinedOf('queue'),
      [`/threads/${threadId}/queue`],
      (h) => h.threads().getQueue({ threadId }),
    ],
    [
      'threadEvents undefined',
      undefinedOf('threadEvents'),
      [`/threads/${threadId}/events`],
      (h) => h.threads().listEvents({ threadId }),
    ],
    [
      'usage undefined',
      { ...workspaceFakes, usage: { thread: () => undefined } },
      [`/threads/${threadId}/usage`],
      (h) => h.threads().getUsage({ threadId }),
    ],
    ...(
      [
        { status: 'missing' },
        { status: 'inactive' },
        { status: 'refused', change: { status: 'outside' } },
        { status: 'refused', change: { status: 'missing' } },
        { status: 'refused', change: { status: 'not-directory' } },
      ] as const
    ).map(
      (result) =>
        [
          `setThreadCwd ${JSON.stringify(result)}`,
          threadsAnswering('setThreadCwd', () => result),
          [`/threads/${threadId}`, 'PATCH', { cwd: '/workspace/x' }],
          (h: Harness) =>
            h.threads().updateThread({ threadId, cwd: '/workspace/x' }),
        ] as const,
    ),
    ...(
      [
        { status: 'missing' },
        { status: 'invalid', reason: 'provider' },
        { status: 'invalid', reason: 'model' },
        { status: 'invalid', reason: 'effort' },
        { status: 'unresolvable', message: 'The provider has no credential.' },
      ] as const
    ).map(
      (result) =>
        [
          `setThreadExecution ${JSON.stringify(result)}`,
          threadsAnswering('setThreadExecution', () => result),
          [
            `/threads/${threadId}`,
            'PATCH',
            { providerId: 'openai', model: 'gpt-5', effort: 'high' },
          ],
          (h: Harness) =>
            h.threads().updateThread({
              threadId,
              providerId: 'openai',
              model: 'gpt-5',
              effort: 'high',
            }),
        ] as const,
    ),
    ...(['missing', 'active'] as const).map(
      (result) =>
        [
          `deleteThread ${result}`,
          threadsAnswering('deleteThread', () => result),
          [`/threads/${threadId}`, 'DELETE'],
          (h: Harness) => h.threads().deleteThread({ threadId }),
        ] as const,
    ),
    ...(['missing', 'inactive'] as const).map(
      (status) =>
        [
          `prompt ${status}`,
          threadsAnswering('prompt', () => ({ status })),
          [`/threads/${threadId}/prompt`, 'POST', { prompt: 'Hello' }],
          (h: Harness) => h.threads().prompt({ threadId, prompt: 'Hello' }),
        ] as const,
    ),
    ...(['missing', 'inactive'] as const).map(
      (status) =>
        [
          `steer ${status}`,
          threadsAnswering('steer', () => ({ status })),
          [
            `/threads/${threadId}/steer`,
            'POST',
            { prompt: 'Change course', promptId },
          ],
          (h: Harness) =>
            h.threads().steer({ threadId, prompt: 'Change course', promptId }),
        ] as const,
    ),
    ...(
      ['missing', 'inactive', 'busy', 'unknown_prompt', 'storage_low'] as const
    ).map(
      (status) =>
        [
          `resume ${status}`,
          threadsAnswering('resume', () => ({ status })),
          [`/threads/${threadId}/resume`, 'POST', { promptId }],
          (h: Harness) => h.threads().resume({ threadId, promptId }),
        ] as const,
    ),
    ...(['missing', 'inactive', 'busy', 'unknown_prompt'] as const).map(
      (status) =>
        [
          `rewind ${status}`,
          threadsAnswering('rewind', () => ({ status })),
          [
            `/threads/${threadId}/rewind`,
            'POST',
            { promptId, prompt: 'Again' },
          ],
          (h: Harness) =>
            h.threads().rewind({ threadId, promptId, prompt: 'Again' }),
        ] as const,
    ),
    ...(['missing', 'inactive', 'not_running'] as const).map(
      (result) =>
        [
          `pause ${result}`,
          threadsAnswering('pause', () => result),
          [`/threads/${threadId}/interrupt`, 'POST', { promptId }],
          (h: Harness) => h.threads().interrupt({ threadId, promptId }),
        ] as const,
    ),
    ...(
      ['missing', 'inactive', 'busy', 'unknown_prompt', 'storage_low'] as const
    ).map(
      (status) =>
        [
          `resumeQueue ${status}`,
          threadsAnswering('resumeQueue', () => ({ status })),
          [`/threads/${threadId}/queue/resume`, 'POST'],
          (h: Harness) => h.threads().resumeQueue({ threadId }),
        ] as const,
    ),
    ...(['missing', 'inactive', 'busy', 'unknown_prompt'] as const).map(
      (result) =>
        [
          `removeQueued ${result}`,
          threadsAnswering('removeQueued', () => result),
          [`/threads/${threadId}/queue/${promptId}`, 'DELETE'],
          (h: Harness) =>
            h.threads().deleteQueuedPrompt({ threadId, promptId }),
        ] as const,
    ),
    [
      'queuedPrompt undefined',
      undefinedOf('queuedPrompt'),
      [`/threads/${threadId}/queue/${promptId}`],
      (h) => h.threads().getQueuedPrompt({ threadId, promptId }),
    ],
    ...(
      [
        'missing',
        'inactive',
        'unknown_prompt',
        'not_editable',
        'conflict',
        'invalid_prompt',
      ] as const
    ).map(
      (status) =>
        [
          `editQueued ${status}`,
          threadsAnswering('editQueued', () => ({ status })),
          [
            `/threads/${threadId}/queue/${promptId}`,
            'PATCH',
            { text: 'Edited', revision: 1 },
          ],
          (h: Harness) =>
            h.threads().updateQueuedPrompt({
              threadId,
              promptId,
              text: 'Edited',
              revision: 1,
            }),
          // Q2: the queued edit's `invalid_prompt` keeps its 409 but reads INVALID_ARGUMENT by its row.
          status === 'invalid_prompt' ? Code.InvalidArgument : undefined,
        ] as const,
    ),
    ...(
      [
        { status: 'missing' },
        { status: 'inactive' },
        { status: 'pending' },
        { status: 'refused', message: 'The branch has uncommitted changes.' },
      ] as const
    ).map(
      (result) =>
        [
          `switchBranch ${JSON.stringify(result)}`,
          {
            ...workspaceFakes,
            git: { ...workspaceFakes.git, switchBranch: () => result },
          },
          [
            `/threads/${threadId}/branches`,
            'POST',
            { branch: 'main', cwd: '/workspace' },
          ],
          (h: Harness) =>
            h
              .threads()
              .createBranch({ threadId, branch: 'main', cwd: '/workspace' }),
        ] as const,
    ),
    [
      'git status missing',
      {
        ...workspaceFakes,
        git: { ...workspaceFakes.git, status: () => ({ status: 'missing' }) },
      },
      [`/threads/${threadId}/git`],
      (h) => h.threads().getGit({ threadId }),
    ],
    [
      'terminal/v1 create undefined',
      {
        ...workspaceFakes,
        terminal: { ...workspaceFakes.terminal, create: () => undefined },
      },
      [`/threads/${threadId}/terminals`, 'POST'],
      (h) => h.threads().createTerminal({ threadId }),
    ],
    [
      'compact refused',
      threadsAnswering('compact', () => ({
        status: 'refused',
        reason: 'nothing_to_compact',
      })),
      [`/threads/${threadId}/compact`, 'POST'],
      (h) => h.threads().compact({ threadId }),
    ],
    [
      'compact busy',
      threadsAnswering('compact', () => ({ status: 'busy' })),
      [`/threads/${threadId}/compact`, 'POST'],
      (h) => h.threads().compact({ threadId }),
    ],
    [
      'unexpected failure',
      threadsAnswering('thread', () => {
        throw new Error('secret provider credentials');
      }),
      [`/threads/${threadId}`],
      (h) => h.threads().getThread({ threadId }),
    ],
  ];
};

void test("P1: each runtime outcome of the Thread routes ends the RPC with the route's reason, message and §5 code", async (t) => {
  for (const [name, fakes, route, call, code] of refusalCases()) {
    await assertRefusalParity(t, fakes, route, call, name, code);
  }
});

void test("P2: one success per ThreadsService RPC answers the route's body under its wrapper", async (t) => {
  const asIs = (body: unknown) => body;
  const ready = (body: unknown) => ({ status: 'ready', value: body });
  const empty = () => ({});
  const cases = [
    [
      'GetThread',
      [`/threads/${threadId}`],
      GetThreadResponseSchema,
      (h: Harness) => h.threads().getThread({ threadId }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'UpdateThread',
      [`/threads/${threadId}`, 'PATCH', { name: 'Renamed' }],
      UpdateThreadResponseSchema,
      (h: Harness) => h.threads().updateThread({ threadId, name: 'Renamed' }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'GetGit',
      [`/threads/${threadId}/git`],
      GetGitResponseSchema,
      (h: Harness) => h.threads().getGit({ threadId }),
      ready,
    ],
    [
      'ListBranches',
      [`/threads/${threadId}/branches`],
      ListBranchesResponseSchema,
      (h: Harness) => h.threads().listBranches({ threadId }),
      ready,
    ],
    [
      'CreateBranch',
      [
        `/threads/${threadId}/branches`,
        'POST',
        { branch: 'main', cwd: '/workspace' },
      ],
      CreateBranchResponseSchema,
      (h: Harness) =>
        h
          .threads()
          .createBranch({ threadId, branch: 'main', cwd: '/workspace' }),
      (body: unknown) => ({ branches: body }),
    ],
    [
      'Prompt',
      [`/threads/${threadId}/prompt`, 'POST', { prompt: 'Hello' }],
      PromptResponseSchema,
      (h: Harness) => h.threads().prompt({ threadId, prompt: 'Hello' }),
      asIs,
    ],
    [
      'Steer',
      [`/threads/${threadId}/steer`, 'POST', { prompt: 'Change', promptId }],
      SteerResponseSchema,
      (h: Harness) =>
        h.threads().steer({ threadId, prompt: 'Change', promptId }),
      asIs,
    ],
    [
      'Resume',
      [`/threads/${threadId}/resume`, 'POST', { promptId }],
      ResumeResponseSchema,
      (h: Harness) => h.threads().resume({ threadId, promptId }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'Rewind',
      [`/threads/${threadId}/rewind`, 'POST', { promptId, prompt: 'Again' }],
      RewindResponseSchema,
      (h: Harness) =>
        h.threads().rewind({ threadId, promptId, prompt: 'Again' }),
      asIs,
    ],
    [
      'Compact',
      [`/threads/${threadId}/compact`, 'POST'],
      CompactResponseSchema,
      (h: Harness) => h.threads().compact({ threadId }),
      asIs,
    ],
    [
      'Interrupt',
      [`/threads/${threadId}/interrupt`, 'POST', { promptId }],
      InterruptResponseSchema,
      (h: Harness) => h.threads().interrupt({ threadId, promptId }),
      asIs,
    ],
    [
      'ListEvents',
      [`/threads/${threadId}/events?afterSequence=0`],
      ListEventsResponseSchema,
      (h: Harness) => h.threads().listEvents({ threadId }),
      (body: unknown) => ({ threadEventLog: body }),
    ],
    [
      'GetUsage',
      [`/threads/${threadId}/usage`],
      GetUsageResponseSchema,
      (h: Harness) => h.threads().getUsage({ threadId }),
      (body: unknown) => ({ threadUsage: body }),
    ],
    [
      'GetQueue',
      [`/threads/${threadId}/queue`],
      GetQueueResponseSchema,
      (h: Harness) => h.threads().getQueue({ threadId }),
      (body: unknown) => ({ threadQueue: body }),
    ],
    [
      'ResumeQueue',
      [`/threads/${threadId}/queue/resume`, 'POST'],
      ResumeQueueResponseSchema,
      (h: Harness) => h.threads().resumeQueue({ threadId }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'GetQueuedPrompt',
      [`/threads/${threadId}/queue/${promptId}`],
      GetQueuedPromptResponseSchema,
      (h: Harness) => h.threads().getQueuedPrompt({ threadId, promptId }),
      (body: unknown) => ({ queuedPrompt: body }),
    ],
    [
      'UpdateQueuedPrompt',
      [
        `/threads/${threadId}/queue/${promptId}`,
        'PATCH',
        { text: 'Edited', revision: 1 },
      ],
      UpdateQueuedPromptResponseSchema,
      (h: Harness) =>
        h.threads().updateQueuedPrompt({
          threadId,
          promptId,
          text: 'Edited',
          revision: 1,
        }),
      (body: unknown) => ({ queuedPrompt: body }),
    ],
    [
      'DeleteQueuedPrompt',
      [`/threads/${threadId}/queue/${promptId}`, 'DELETE'],
      DeleteQueuedPromptResponseSchema,
      (h: Harness) => h.threads().deleteQueuedPrompt({ threadId, promptId }),
      empty,
    ],
    [
      'CreateTerminal',
      [`/threads/${threadId}/terminals`, 'POST', { cols: 80, rows: 24 }],
      CreateTerminalResponseSchema,
      (h: Harness) =>
        h.threads().createTerminal({ threadId, cols: 80, rows: 24 }),
      (body: unknown) => ({ terminalSession: body }),
    ],
    [
      'TerminateThread',
      [`/threads/${threadId}/terminate`, 'POST'],
      TerminateThreadResponseSchema,
      (h: Harness) => h.threads().terminateThread({ threadId }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'DeleteThread',
      [`/threads/${threadId}`, 'DELETE'],
      DeleteThreadResponseSchema,
      (h: Harness) => h.threads().deleteThread({ threadId }),
      empty,
    ],
  ] as const;

  for (const [rpc, route, schema, call, wrap] of cases) {
    await assertSuccessParity(
      t,
      workspaceFakes,
      route,
      schema,
      call as never,
      wrap,
      rpc,
    );
  }
});

// M1 / M2 in process ----------------------------------------------------------------

void test('M1: a request breaking a rule of each field answers INVALID_ARGUMENT with the table reason, before any call', async (t) => {
  const h = await served(t);
  const bad = 'not-an-id';
  const id = refused(
    'invalid_thread_id',
    'The thread ID is invalid.',
    Code.InvalidArgument,
  );
  const of = (reason: string, message: string) =>
    refused(reason, message, Code.InvalidArgument);
  const cases: readonly (readonly [string, () => Promise<unknown>, Refusal])[] =
    [
      ['GetThread id', () => h.threads().getThread({ threadId: bad }), id],
      [
        'UpdateThread effort',
        () => h.threads().updateThread({ threadId, effort: 'extreme' }),
        of(
          'invalid_thread',
          'A Thread name, a working directory, an execution (providerId and model, with an optional effort), or a combination is required.',
        ),
      ],
      [
        'CreateBranch branch',
        () => h.threads().createBranch({ threadId, branch: '-x', cwd: '/w' }),
        of('invalid_branch', 'An existing local branch name is required.'),
      ],
      [
        'Prompt prompt',
        () => h.threads().prompt({ threadId, prompt: ' ' }),
        of('invalid_prompt', 'Only a non-empty prompt is accepted.'),
      ],
      [
        'Steer promptId',
        () => h.threads().steer({ threadId, prompt: 'x', promptId: bad }),
        of(
          'invalid_steer',
          'A non-empty prompt and the running promptId are required.',
        ),
      ],
      [
        'Resume promptId',
        () => h.threads().resume({ threadId, promptId: bad }),
        of('invalid_resume', 'A promptId is required.'),
      ],
      [
        'Rewind prompt',
        () => h.threads().rewind({ threadId, promptId, prompt: '' }),
        of(
          'invalid_rewind',
          'A prompt ID and a non-empty prompt are required.',
        ),
      ],
      [
        'Interrupt promptId',
        () => h.threads().interrupt({ threadId, promptId: bad }),
        of('invalid_interrupt', 'A promptId is required.'),
      ],
      [
        'ListEvents afterSequence',
        () => h.threads().listEvents({ threadId, afterSequence: -1 }),
        of('invalid_event_cursor', 'The event cursor is invalid.'),
      ],
      [
        'GetQueuedPrompt promptId',
        () => h.threads().getQueuedPrompt({ threadId, promptId: bad }),
        of('invalid_prompt', 'A promptId is required.'),
      ],
      [
        'UpdateQueuedPrompt text',
        () =>
          h
            .threads()
            .updateQueuedPrompt({ threadId, promptId, text: ' ', revision: 1 }),
        of(
          'invalid_prompt',
          'A prompt ID, non-empty text and its revision are required.',
        ),
      ],
      [
        'DeleteQueuedPrompt promptId',
        () => h.threads().deleteQueuedPrompt({ threadId, promptId: bad }),
        of('invalid_prompt', 'A promptId is required.'),
      ],
      [
        'CreateTerminal cols',
        () => h.threads().createTerminal({ threadId, cols: 0 }),
        of('invalid_terminal', 'Invalid terminal dimensions.'),
      ],
      ['Compact id', () => h.threads().compact({ threadId: bad }), id],
      ['GetUsage id', () => h.threads().getUsage({ threadId: bad }), id],
      [
        'DeleteThread id',
        () => h.threads().deleteThread({ threadId: bad }),
        id,
      ],
    ];

  for (const [label, call, expected] of cases) {
    assert.deepEqual(await refusalOf(call()), expected, label);
  }
  assert.deepEqual(h.calls, []);
});

void test('M2: a Thread request breaking the path field and a body rule answers the path reason', async (t) => {
  const h = await served(t);

  assert.deepEqual(
    await refusalOf(h.threads().prompt({ threadId: 'not-an-id', prompt: ' ' })),
    refused(
      'invalid_thread_id',
      'The thread ID is invalid.',
      Code.InvalidArgument,
    ),
  );
});
