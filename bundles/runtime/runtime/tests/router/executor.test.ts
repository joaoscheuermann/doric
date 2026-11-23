// The routed executor (phase 3, slice S48b, contract §2.3–§2.9, §5): the
// executor port over `executor/v1`, the executor sessions it opens and
// `executor.session/v1`, which the executor calls back through. Tests 5–25
// of the slice; the fake `executor/v1` provider is `./executor.ts`.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { describe } from 'node:test';

import { type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';
import { decodeJson, encodeJson } from 'storage/rpc';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import type {
  ExecutorCompactionResult,
  ExecutorThread,
  HistoryReader,
  PromptSession,
} from '../../src/contracts/executor.js';
import {
  type RecordRequestSchema,
  SessionService,
  SteerInputSchema,
} from '../../src/contracts/gen/doric/executor/session/v1/session_pb.js';
import { ExecutorService } from '../../src/contracts/gen/doric/executor/v1/executor_pb.js';
import type { AttachRequestSchema } from '../../src/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { type RemotePromptSession, serveExecutor } from '../../src/executor.js';
import { createExecutorSessions } from '../../src/host/executor-sessions.js';
import { routedExecutor } from '../../src/host/routed-executor.js';
import { decode, runtimeOneofs } from '../../src/host/rpc/codec.js';
import { routedSessionService } from '../../src/host/rpc/session.js';
import { defaultConfiguration, epoch } from '../domain/support/harness.js';
import { messagesOf, testHistoryFormat } from '../support/executor.js';
import { type ExecutorCall, executorCaller } from './executor.js';
import {
  assertFails,
  callsOf,
  contextHarness,
  contractErrorOf,
  eventually,
  failingBackend,
  type Gate,
  gate,
  type Harness,
  type HarnessOptions,
  projectState,
  putsOf,
  rejectionOf,
  settle,
  started,
  storageTypes,
  within,
} from './support.js';

const MiB = 1024 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `default`, another generation: another instance of the executor's provider. */
const nextGeneration: Caller = { ...executorCaller, generation: 2 };
/** A bundle that does not provide `executor/v1`. */
const otherBundle: Caller = {
  bundleId: 'other',
  version: '1.0.0',
  generation: 1,
};

/** A started harness whose executor is the routed fake `executor/v1` provider. */
const routed = (
  t: Parameters<typeof started>[0],
  options: HarnessOptions = {},
): Promise<Harness> => started(t, { executor: 'routed', ...options });

/** Resolves when `held` opens or the run is stopped. */
const holdUntil = (held: Gate, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    void held.promise.then(resolve);
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

async function* streamOf<T>(items: readonly T[]) {
  for (const item of items) yield item;
}

/** `openrouter` lists `m-1` (low) and `m-2` (low, high). */
const executionConfiguration = (): {
  configuration: ConfigurationValue;
  revision: number;
  updatedAt: string;
} => {
  const [openrouter] = defaultConfiguration.providers;
  assert.ok(openrouter !== undefined);

  return {
    configuration: {
      ...defaultConfiguration,
      providers: [
        {
          ...openrouter,
          models: [
            { name: 'm-1', reasonings: ['low'] },
            { name: 'm-2', reasonings: ['low', 'high'] },
          ],
        },
      ],
      models: {
        execution: { providerId: 'openrouter', model: 'm-1', effort: 'low' },
      },
    },
    revision: 1,
    updatedAt: epoch,
  };
};

/** A ready Project created through `runtime/v2`. */
const readyProject = async (h: Harness, name = 'Project') => {
  const { project } = await h.runtime().createProject({ name });
  assert.ok(project !== undefined);
  await projectState(h, project.id, 'ready');

  return project;
};

/** A ready Project and a Thread in it, created through the routed RPCs. */
const readyThread = async (h: Harness, name = 'Thread') => {
  const project = await readyProject(h);
  const { thread } = await h.threads().createThread({
    projectId: project.id,
    name,
  });
  assert.ok(thread !== undefined);

  return { project, thread };
};

/** Another Thread in Project `projectId`. */
const newThread = async (h: Harness, projectId: string, name: string) => {
  const { thread } = await h.threads().createThread({ projectId, name });
  assert.ok(thread !== undefined);

  return thread;
};

/** Prompts Thread `id`; answers the accepted prompt's id. */
const prompted = async (h: Harness, id: string, prompt: string) => {
  const { promptResult } = await h.threads().prompt({ id, prompt });
  assert.equal(promptResult?.status, 'accepted');
  assert.ok(promptResult?.promptId !== undefined);

  return promptResult.promptId;
};

/** Waits until prompt `promptId` of Thread `id` finished; answers its outcome. */
const finished = async (h: Harness, id: string, promptId: string) => {
  const outcome = async () => (await h.threads().thread({ id })).thread?.result;
  await eventually(
    async () => (await outcome())?.promptId === promptId,
    `prompt ${promptId} finished`,
  );
  const result = await outcome();
  assert.ok(result !== undefined);

  return result;
};

/** The Thread record as `Thread` answers it now. */
const threadOf = async (h: Harness, id: string) => {
  const { thread } = await h.threads().thread({ id });
  assert.ok(thread !== undefined);

  return thread;
};

/** Waits until Thread `id` reads `state`. */
const threadState = (h: Harness, id: string, state: string) =>
  eventually(
    async () => (await threadOf(h, id)).state === state,
    `Thread ${id} ${state}`,
  );

/** The `executor/v1` calls of `method` made for Thread `threadId`. */
const callsFor = (h: Harness, method: string, threadId: string) =>
  h.executor
    .callsOf(method as never)
    .filter(({ scope }) => scope?.threadId === threadId);

/** The `sessionId` of a recorded `executor/v1` call. */
const sessionIdOf = (call: ExecutorCall | undefined): string => {
  const sessionId = (call?.request as { sessionId?: unknown } | undefined)
    ?.sessionId;
  assert.equal(typeof sessionId, 'string');

  return sessionId as string;
};

/** Waits for the `Run` of Thread `threadId`; answers its session id. */
const runSession = async (h: Harness, threadId: string) => {
  await eventually(
    () => callsFor(h, 'run', threadId).length > 0,
    `the Run of ${threadId}`,
  );

  return sessionIdOf(callsFor(h, 'run', threadId)[0]);
};

/** The gRPC code and Doric error of a failed call. */
const failure = async (promise: Promise<unknown>) => {
  const rejected = await rejectionOf(promise);
  assert.ok(rejected instanceof ConnectError, String(rejected));

  return { grpc: rejected.code, error: contractErrorOf(rejected) };
};

/** Asserts a call fails NOT_FOUND `unknown_session`. */
const assertUnknownSession = async (
  promise: Promise<unknown>,
  what: string,
) => {
  const { grpc, error } = await failure(promise);
  assert.equal(grpc, Code.NotFound, `${what}: ${error.message}`);
  assert.equal(error.code, 'unknown_session', what);
};

/** `ReadHistory{sessionId, part}` as `caller`: the head's format, the chunk sizes and the value. */
const readPart = async (
  h: Harness,
  sessionId: string,
  part: string,
  caller?: Caller,
) => {
  const chunks: Uint8Array[] = [];
  let format: string | undefined;
  let heads = 0;
  for await (const { item } of h
    .session(caller)
    .readHistory({ sessionId, part })) {
    if (item.case === 'head') {
      heads += 1;
      format = item.value.format;
    }
    if (item.case === 'chunk') chunks.push(item.value);
  }
  assert.equal(heads, 1, 'one head');

  return {
    format,
    sizes: chunks.map(({ length }) => length),
    value:
      chunks.length === 0 ? undefined : decodeJson(chunks, 'invalid_output'),
  };
};

/** The messages stored for Thread `id`, read as another process would. */
const storedMessages = async (h: Harness, id: string) =>
  messagesOf(await h.seed.threads.history(id));

/** The Thread's log, `{type, event}` per event, in order. */
const eventsOf = async (h: Harness, id: string) =>
  (
    (await h.threads().threadEvents({ id, afterSequence: 0 })).threadEventLog
      ?.events ?? []
  ).map(({ type, event }) => ({
    type,
    event: event === undefined ? undefined : toJson(ValueSchema, event),
  }));

/** The Doric code of a logged `err`, when it is a Doric error. */
const codeOf = (error: unknown): string | undefined => {
  if (error instanceof ConnectError) return fromConnectError(error).code;
  return isContractError(error) ? error.code : undefined;
};

type RecordItem = MessageInitShape<typeof RecordRequestSchema>;
type AttachItem = MessageInitShape<typeof AttachRequestSchema>;

/** `size` bytes that start as a PNG, each byte after the signature `fill`. */
const png = (size: number, fill: number): Uint8Array => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return bytes;
};

/** Attaches `bytes` as `name` to Thread `threadId` of Project `projectId`. */
const attach = async (
  h: Harness,
  scope: { projectId: string; threadId: string },
  name: string,
  bytes: Uint8Array,
) => {
  const items: AttachItem[] = [
    { item: { case: 'head', value: { name } } },
    { item: { case: 'chunk', value: bytes } },
  ];
  const { attachment } = await within(
    h.attachments(scope).attach(streamOf(items)),
    'Attach',
  );
  assert.ok(attachment !== undefined);

  return attachment;
};

describe('S48b: executor/v1 through the router', () => {
  test('5: activate resolves with no executor/v1 and no doric.catalog/v1 call, also with no ExecutorService provider at all', async (t) => {
    for (const executor of ['routed', 'absent'] as const) {
      const h = await started(t, { executor });

      assert.deepEqual(h.executor.calls, [], executor);
      assert.deepEqual(callsOf(h, 'catalog.get'), [], executor);
    }
  });

  test('6: a prompt calls Checkpoint then Run, each with its own UUID session and the prompt scope; Run carries the Thread (model, effort, agent with instructions) and the job; the prompt finishes with the script text', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      configuration: executionConfiguration,
      execute: async (run) => {
        if (run.job.prompt === 'parent') await holdUntil(held, run.signal);

        return `answer to ${run.job.prompt}`;
      },
    });
    const { project, thread: parent } = await readyThread(h, 'Parent');
    const parentPrompt = await prompted(h, parent.id, 'parent');
    await runSession(h, parent.id);
    const scope: CallScope = {
      projectId: project.id,
      threadId: parent.id,
      promptId: parentPrompt,
    };

    const spawned = await h.threads(scope).spawn({
      prompt: 'task',
      options: {
        agent: {
          name: 'reviewer',
          source: 'workspace',
          instructions: 'Review the change.',
        },
        model: 'm-2',
        effort: 'high',
      },
    });
    const child = await finished(h, spawned.threadId, spawned.promptId);
    held.open();
    // The child's result reaches the parent as a prompt of its own, queued
    // behind the held one: the parent runs twice.
    await eventually(
      () => callsFor(h, 'run', parent.id).length === 2,
      'the Run of the result prompt',
    );
    const [parentRun, resultRun] = callsFor(h, 'run', parent.id);
    const resultJob = (
      resultRun?.request as
        | { job?: { id?: string; prompt?: string; source?: unknown } }
        | undefined
    )?.job;
    assert.ok(resultJob?.id !== undefined, 'the result prompt id');
    const outcome = await finished(h, parent.id, resultJob.id);

    assert.deepEqual(
      { status: child.status, text: child.text },
      { status: 'completed', text: 'answer to task' },
    );
    assert.deepEqual(
      { status: outcome.status, text: outcome.text },
      { status: 'completed', text: `answer to ${resultJob.prompt}` },
    );
    assert.notEqual(resultJob.id, parentPrompt);
    const resultSource = resultJob.source as
      | { kind?: unknown; threadId?: unknown; promptId?: unknown }
      | undefined;
    assert.deepEqual(
      {
        kind: resultSource?.kind,
        threadId: resultSource?.threadId,
        promptId: resultSource?.promptId,
      },
      {
        kind: 'result',
        threadId: spawned.threadId,
        promptId: spawned.promptId,
      },
    );
    const parentCalls = h.executor.calls.filter(
      ({ method, scope: called }) =>
        method !== 'formats' && called?.threadId === parent.id,
    );
    assert.deepEqual(
      parentCalls.map(({ method }) => method),
      ['checkpoint', 'run', 'checkpoint', 'run'],
    );
    const sessions = parentCalls.map(sessionIdOf);
    for (const id of sessions) assert.match(id, uuid);
    assert.equal(new Set(sessions).size, 4, 'a session per call');
    const resultScope: CallScope = { ...scope, promptId: resultJob.id };
    assert.deepEqual(
      parentCalls.map(({ scope: called }) => ({ ...called })),
      [scope, scope, resultScope, resultScope],
    );
    assert.deepEqual(
      (parentRun?.request as { job?: unknown } | undefined)?.job,
      { id: parentPrompt, prompt: 'parent', source: { kind: 'user' } },
    );

    const [childRun] = callsFor(h, 'run', spawned.threadId);
    assert.deepEqual(
      { ...childRun?.scope },
      {
        projectId: project.id,
        threadId: spawned.threadId,
        promptId: spawned.promptId,
      },
    );
    const request = childRun?.request as {
      thread?: {
        id?: string;
        model?: string;
        effort?: string;
        agent?: unknown;
      };
      job?: unknown;
    };
    assert.deepEqual(
      {
        id: request.thread?.id,
        model: request.thread?.model,
        effort: request.thread?.effort,
        agent: request.thread?.agent,
      },
      {
        id: spawned.threadId,
        model: 'm-2',
        effort: 'high',
        agent: {
          name: 'reviewer',
          source: 'workspace',
          instructions: 'Review the change.',
        },
      },
    );
    assert.deepEqual(request.job, {
      id: spawned.promptId,
      prompt: 'task',
      source: { kind: 'parent', threadId: parent.id, promptId: parentPrompt },
    });
  });

  test('7: a run records messages through Record and the next prompt reads them back through ReadHistory; a 2.5 MiB message travels in ≥ 3 chunks of ≤ 1 MiB each way (T3.3)', async (t) => {
    const big = 'x'.repeat(2.5 * MiB);
    const read: unknown[] = [];
    const h = await routed(t, {
      execute: async (run) => {
        if (run.job.prompt === 'write') await run.append('hello', big);
        else read.push(await messagesOf(run.session.history));

        return 'done';
      },
    });
    const { thread } = await readyThread(h);

    await finished(h, thread.id, await prompted(h, thread.id, 'write'));
    await finished(h, thread.id, await prompted(h, thread.id, 'read'));

    const [messages] = read as [readonly unknown[] | undefined];
    assert.equal(messages?.length, 2);
    assert.equal(messages?.[0], 'hello');
    assert.ok(messages?.[1] === big, 'the 2.5 MiB message round-trips');
    const [record] = h.executor.traffic.filter(
      ({ method, chunks }) => method === 'record' && chunks.length > 0,
    );
    assert.ok(record !== undefined, 'a Record with chunks');
    assert.ok(record.chunks.length >= 3, `${record.chunks.length} chunks`);
    for (const size of record.chunks) assert.ok(size > 0 && size <= MiB);
    const answered = h.executor.traffic.filter(
      ({ method, part, chunks }) =>
        method === 'readHistory' && part === 'messages' && chunks.length > 0,
    );
    const last = answered.at(-1);
    assert.ok(last !== undefined, 'a ReadHistory that answered messages');
    assert.equal(last.format, testHistoryFormat);
    assert.ok(last.chunks.length >= 3, `${last.chunks.length} chunks`);
    for (const size of last.chunks) assert.ok(size > 0 && size <= MiB);
  });

  test('8: Record with an event saves the history, then the event lands in the Thread log of the prompt', async (t) => {
    const h = await routed(t, {
      execute: async (run) => {
        await run.session.record({
          history: { format: testHistoryFormat, parts: { messages: ['m1'] } },
          event: { type: 'text.delta', text: 'kept' },
        });

        return 'done';
      },
    });
    const { thread } = await readyThread(h);

    const promptId = await prompted(h, thread.id, 'go');
    assert.equal((await finished(h, thread.id, promptId)).status, 'completed');

    assert.deepEqual(await storedMessages(h, thread.id), ['m1']);
    const types = (await eventsOf(h, thread.id)).map(({ type }) => type);
    const delta = types.indexOf('text.delta');
    assert.ok(delta >= 0, `the event is logged: ${types.join(', ')}`);
    assert.ok(delta > types.indexOf('prompt.started'));
    assert.ok(delta < types.lastIndexOf('prompt.finished'));
    const logged = (await eventsOf(h, thread.id))[delta]?.event as
      | { text?: unknown }
      | undefined;
    assert.equal(logged?.text, 'kept');
  });

  test('9: a malformed Record (a chunk before any part, parts without format, two heads) fails INVALID_ARGUMENT invalid_input and saves nothing', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    await h.seed.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: ['before'] },
    });
    await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);
    const [chunk] = encodeJson(['after']);
    assert.ok(chunk !== undefined);
    const head = (format?: string): RecordItem => ({
      item: {
        case: 'head',
        value: { sessionId, ...(format === undefined ? {} : { format }) },
      },
    });
    const cases: readonly { what: string; items: RecordItem[] }[] = [
      {
        what: 'a chunk before any part',
        items: [
          head(testHistoryFormat),
          { item: { case: 'chunk', value: chunk } },
        ],
      },
      {
        what: 'parts without format',
        items: [
          head(),
          { item: { case: 'part', value: 'messages' } },
          { item: { case: 'chunk', value: chunk } },
        ],
      },
      {
        what: 'two heads',
        items: [head(testHistoryFormat), head(testHistoryFormat)],
      },
    ];

    for (const { what, items } of cases) {
      const { grpc, error } = await failure(
        h.session().record(streamOf(items)),
      );
      assert.equal(grpc, Code.InvalidArgument, `${what}: ${error.message}`);
      assert.equal(error.code, 'invalid_input', what);
      assert.deepEqual(
        (await readPart(h, sessionId, 'messages')).value,
        ['before'],
        `${what}: nothing saved`,
      );
    }
    assert.deepEqual(await storedMessages(h, thread.id), ['before']);
    held.open();
  });

  test('10: a Record whose history write fails in storage fails UNAVAILABLE unavailable, and the prompt ends as a persistence failure does', async (t) => {
    const backend = failingBackend(
      (method, input) =>
        method === 'commit' &&
        putsOf(
          input,
          storageTypes.history,
          (document) => document.part === 'messages',
        ),
    );
    t.after(() => backend.close());
    const recordFailures: unknown[] = [];
    const h = await routed(t, {
      backend,
      execute: async (run) => {
        try {
          await run.append('lost');
        } catch (error) {
          recordFailures.push(error);
          throw error;
        }

        return 'done';
      },
    });
    const { thread } = await readyThread(h);

    await prompted(h, thread.id, 'go');
    await threadState(h, thread.id, 'failed');

    assert.equal(recordFailures.length, 1);
    // The fake's session is `remotePromptSession` (S51b), which rejects with
    // the Doric error `fromConnectError` reads from the UNAVAILABLE answer.
    const [rejected] = recordFailures;
    assert.ok(isContractError(rejected), String(rejected));
    assert.equal(rejected.code, 'unavailable');
    assert.equal(
      (await threadOf(h, thread.id)).errorCode,
      'persistence_failed',
    );
  });

  test('11: TakeSteers answers the steering sent to a held run oldest first, each once; the next call answers none', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);

    for (const prompt of ['first steer', 'second steer'])
      await h.threads().steer({ id: thread.id, prompt, promptId });
    const taken = await h.session().takeSteers({ sessionId });
    const again = await h.session().takeSteers({ sessionId });

    assert.deepEqual(
      taken.steers.map((steer) =>
        decode(SteerInputSchema, steer, runtimeOneofs),
      ),
      [
        { prompt: 'first steer', source: { kind: 'user' } },
        { prompt: 'second steer', source: { kind: 'user' } },
      ],
    );
    assert.deepEqual(again.steers, []);
    held.open();
  });

  test("12: DescribeAttachment answers an attachment of the Thread's Project as {id, name, mediaType, size}; an unknown id and another Project's attachment answer none", async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { project, thread } = await readyThread(h);
    const otherProject = await readyProject(h, 'Other');
    const otherThread = await newThread(h, otherProject.id, 'Elsewhere');
    const own = await attach(
      h,
      { projectId: project.id, threadId: thread.id },
      'screen.png',
      png(64, 1),
    );
    const foreign = await attach(
      h,
      { projectId: otherProject.id, threadId: otherThread.id },
      'other.png',
      png(64, 2),
    );
    await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);

    const described = await h
      .session()
      .describeAttachment({ sessionId, id: own.id });

    assert.deepEqual(
      {
        id: described.attachment?.id,
        name: described.attachment?.name,
        mediaType: described.attachment?.mediaType,
        size: described.attachment?.size,
      },
      { id: own.id, name: 'screen.png', mediaType: 'image/png', size: 64 },
    );
    for (const id of [`sha256-${'0'.repeat(64)}`, foreign.id])
      assert.equal(
        (await h.session().describeAttachment({ sessionId, id })).attachment,
        undefined,
        id,
      );
    held.open();
  });

  test('13: another bundle using a live session id fails NOT_FOUND unknown_session; the session still answers its executor afterwards (T3.3)', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);

    await assertUnknownSession(
      h.session(otherBundle).takeSteers({ sessionId }),
      'another bundle',
    );
    assert.deepEqual((await h.session().takeSteers({ sessionId })).steers, []);
    held.open();
  });

  test('14: the first callback binds the session to its instance: another generation is refused after it, and binds first when it calls first (T3.3)', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { project, thread: first } = await readyThread(h);
    const second = await newThread(h, project.id, 'Second');
    await prompted(h, first.id, 'hold');
    await prompted(h, second.id, 'hold');
    const firstSession = await runSession(h, first.id);
    const secondSession = await runSession(h, second.id);

    await h.session().takeSteers({ sessionId: firstSession });
    await assertUnknownSession(
      h.session(nextGeneration).takeSteers({ sessionId: firstSession }),
      'generation 2 after generation 1 called',
    );
    assert.deepEqual(
      (await h.session().takeSteers({ sessionId: firstSession })).steers,
      [],
    );

    await h.session(nextGeneration).takeSteers({ sessionId: secondSession });
    await assertUnknownSession(
      h.session().takeSteers({ sessionId: secondSession }),
      'generation 1 after generation 2 called',
    );
    held.open();
  });

  test("15: an unknown session id, and a run's id after the run finished, fail unknown_session", async (t) => {
    const h = await routed(t);
    const { thread } = await readyThread(h);

    await finished(h, thread.id, await prompted(h, thread.id, 'go'));
    const ended = sessionIdOf(callsFor(h, 'run', thread.id)[0]);

    await assertUnknownSession(
      h.session().takeSteers({ sessionId: randomUUID() }),
      'an unknown id',
    );
    await assertUnknownSession(
      h.session().takeSteers({ sessionId: ended }),
      'the finished run',
    );
    await assertUnknownSession(
      readPart(h, ended, 'messages'),
      'ReadHistory of the finished run',
    );
  });

  test('16: a checkpoint session reads the history; Record on it fails UNIMPLEMENTED unsupported_operation', async (t) => {
    const seen: { messages: unknown; failure: unknown }[] = [];
    const box: { h?: Harness } = {};
    const h = await routed(t, {
      executorOverrides: {
        checkpoint: async function* (request) {
          assert.ok(box.h !== undefined);
          const session = box.h.executor.remote(request.sessionId);
          const messages = await session.history.read('messages');
          let rejected: unknown;
          try {
            await session.record({
              history: { format: testHistoryFormat, parts: { messages: [] } },
            });
          } catch (error) {
            rejected = error;
          }
          seen.push({ messages, failure: rejected });
          yield { item: { case: 'format', value: testHistoryFormat } };
        },
      },
    });
    box.h = h;
    const { thread } = await readyThread(h);
    await h.seed.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: ['before'] },
    });

    await finished(h, thread.id, await prompted(h, thread.id, 'go'));

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.messages, ['before']);
    // The fake's session is `remotePromptSession` (S51b), which rejects with
    // the Doric error `fromConnectError` reads from the UNIMPLEMENTED answer.
    const rejected = seen[0]?.failure;
    assert.ok(isContractError(rejected), String(rejected));
    assert.equal(rejected.code, 'unsupported_operation');
    assert.deepEqual(await storedMessages(h, thread.id), ['before']);
  });

  test('17: a rewind calls Rewind{sessionId, promptId, removedPromptIds} with the rewound prompt scope and stores its history; a Rewind with no item leaves the history as it was', async (t) => {
    const execute = async (
      run: { job: { prompt: string } } & {
        append(...messages: readonly unknown[]): Promise<void>;
      },
    ) => {
      if (run.job.prompt !== 'again') await run.append(run.job.prompt);

      return 'done';
    };
    const twoPrompts = async (h: Harness) => {
      const { project, thread } = await readyThread(h);
      await finished(h, thread.id, await prompted(h, thread.id, 'one'));
      const second = await prompted(h, thread.id, 'two');
      await finished(h, thread.id, second);
      const rewound = await h
        .threads()
        .rewind({ id: thread.id, promptId: second, prompt: 'again' });
      assert.equal(rewound.status, 'accepted');
      assert.ok(rewound.promptId !== undefined);
      await finished(h, thread.id, rewound.promptId);

      return { project, thread, second };
    };

    const h = await routed(t, { execute });
    const { project, thread, second } = await twoPrompts(h);

    const [rewind] = h.executor.callsOf('rewind');
    assert.ok(rewind !== undefined, 'a Rewind call');
    const request = rewind.request as {
      sessionId?: string;
      promptId?: string;
      removedPromptIds?: string[];
    };
    assert.match(request.sessionId ?? '', uuid);
    assert.equal(request.promptId, second);
    assert.deepEqual(request.removedPromptIds, [second]);
    assert.deepEqual(
      { ...rewind.scope },
      { projectId: project.id, threadId: thread.id, promptId: second },
    );
    assert.deepEqual(await storedMessages(h, thread.id), ['one']);

    // A Rewind with no item answers no history: the rewind is refused
    // `unknown_prompt` and the history stays as it was.
    const empty = await routed(t, {
      execute,
      executorOverrides: { rewind: () => streamOf([]) },
    });
    const kept = await readyThread(empty);
    await finished(
      empty,
      kept.thread.id,
      await prompted(empty, kept.thread.id, 'one'),
    );
    const keptSecond = await prompted(empty, kept.thread.id, 'two');
    await finished(empty, kept.thread.id, keptSecond);
    const refused = await empty
      .threads()
      .rewind({ id: kept.thread.id, promptId: keptSecond, prompt: 'again' });
    assert.equal(refused.status, 'unknown_prompt');
    assert.equal(empty.executor.callsOf('rewind').length, 1);
    assert.deepEqual(await storedMessages(empty, kept.thread.id), [
      'one',
      'two',
    ]);
  });

  test('19: an on-demand compaction calls Compact{sessionId, thread, policy} under its own prompt id; compacted maps to the result, a status outside the schema fails invalid_output', async (t) => {
    const h = await routed(t, {
      compact: async () => ({
        status: 'compacted',
        summaryId: 'summary-1',
        condensedMessages: 4,
        retainedMessages: 2,
        tokensFreed: 120,
      }),
    });
    const { project, thread } = await readyThread(h);

    const compacted = await h.threads().compact({ id: thread.id });

    assert.deepEqual(
      {
        status: compacted.status,
        condensedMessages: compacted.condensedMessages,
        retainedMessages: compacted.retainedMessages,
        tokensFreed: compacted.tokensFreed,
      },
      {
        status: 'compacted',
        condensedMessages: 4,
        retainedMessages: 2,
        tokensFreed: 120,
      },
    );
    const [compact] = h.executor.callsOf('compact');
    assert.ok(compact !== undefined, 'a Compact call');
    const request = compact.request as {
      sessionId?: string;
      thread?: { id?: string };
      policy?: { tailMinMessages?: unknown; summaryMaxChars?: unknown };
    };
    assert.match(request.sessionId ?? '', uuid);
    assert.equal(request.thread?.id, thread.id);
    assert.equal(typeof request.policy?.tailMinMessages, 'number');
    assert.equal(typeof request.policy?.summaryMaxChars, 'number');
    assert.equal(compact.scope?.projectId, project.id);
    assert.equal(compact.scope?.threadId, thread.id);
    assert.match(compact.scope?.promptId ?? '', uuid);

    const refused = await routed(t, {
      executorOverrides: {
        compact: () => ({ status: 'exploded' }),
      },
    });
    const other = await readyThread(refused);
    await assertFails(
      refused.threads().compact({ id: other.thread.id }),
      'invalid_output',
    );
  });

  test('20 (S51e): cancelling a running prompt cancels its session; an executor that ignores it has its Run cancelled after the grace (executorCancelGraceMs: 50); a callback with its session id afterwards fails unknown_session', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      executorCancelGraceMs: 50,
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);
    const aborted: { at?: number } = {};
    run.signal.addEventListener(
      'abort',
      () => {
        aborted.at = performance.now();
      },
      { once: true },
    );

    const pausedAt = performance.now();
    const paused = await h.threads().pause({ id: thread.id, promptId });

    assert.equal(paused.interruptResult, 'interrupted');
    await eventually(() => run.signal.aborted, "the Run's signal aborted");
    const abortedAt = aborted.at;
    assert.ok(abortedAt !== undefined);
    // ≥ 50 ms, with 1 ms of timer granularity.
    assert.ok(
      abortedAt - pausedAt >= 49,
      `the Run was cancelled ${(abortedAt - pausedAt).toFixed(1)} ms after the pause, not after the 50 ms grace`,
    );
    const timeouts = h.logs.filter(
      ({ level, fields }) =>
        level === 'warn' && fields?.code === 'executor_cancel_timeout',
    );
    assert.deepEqual(
      timeouts.map(({ message }) => message),
      ['The executor did not end a cancelled run.'],
    );
    await eventually(
      async () => (await threadOf(h, thread.id)).state !== 'running',
      'the run settled',
    );
    await assertUnknownSession(
      h.session().takeSteers({ sessionId }),
      'after the cancelled run',
    );
  });

  test('21: Formats is called once across two prompts; a Thread whose stored format is not listed fails before any Run (history_format_unsupported)', async (t) => {
    const h = await routed(t, {
      // A checkpoint that writes no part, so each Thread keeps the format it was seeded with.
      executorOverrides: {
        checkpoint: () =>
          streamOf([
            { item: { case: 'format' as const, value: testHistoryFormat } },
          ]),
      },
    });
    const { project, thread } = await readyThread(h);
    const legacy = await newThread(h, project.id, 'Legacy');
    await h.seed.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: [] },
    });
    await h.seed.threads.saveHistory(legacy.id, {
      format: 'legacy.history/v1',
      parts: { messages: [] },
    });

    for (const prompt of ['one', 'two'])
      assert.equal(
        (await finished(h, thread.id, await prompted(h, thread.id, prompt)))
          .status,
        'completed',
      );
    assert.equal(h.executor.callsOf('formats').length, 1);

    const refused = await prompted(h, legacy.id, 'refused');
    assert.equal((await finished(h, legacy.id, refused)).status, 'failed');
    assert.deepEqual(callsFor(h, 'run', legacy.id), []);
    assert.ok(
      h.logs.some(
        ({ message, fields }) =>
          message === 'Thread history format is unsupported' &&
          fields?.code === 'history_format_unsupported' &&
          fields.threadId === legacy.id,
      ),
      'history_format_unsupported is logged',
    );
  });

  test('22: a Formats replay to a new provider instance replaces the list: the next prompt uses it, and the catalog is read again', async (t) => {
    const h = await routed(t);
    const { thread } = await readyThread(h);
    await h.seed.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: [] },
    });
    assert.equal(
      (await finished(h, thread.id, await prompted(h, thread.id, 'one')))
        .status,
      'completed',
    );
    assert.equal(callsOf(h, 'catalog.get').length, 1);
    assert.equal(callsFor(h, 'run', thread.id).length, 1);

    h.executor.setFormats(['other/v1']);
    await h.replay(ExecutorService);
    const refused = await prompted(h, thread.id, 'two');

    assert.equal((await finished(h, thread.id, refused)).status, 'failed');
    assert.equal(callsFor(h, 'run', thread.id).length, 1, 'no Run');
    assert.equal(h.executor.callsOf('formats').length, 2);
    assert.equal(callsOf(h, 'catalog.get').length, 2);
  });

  test('23: a first Formats that fails fails that prompt; the next prompt calls Formats again and runs', async (t) => {
    const h = await routed(t);
    const { thread } = await readyThread(h);
    await h.seed.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: [] },
    });
    h.executor.failNext(
      'formats',
      new ContractError('unavailable', 'The executor is restarting.'),
    );

    const first = await prompted(h, thread.id, 'one');
    assert.equal((await finished(h, thread.id, first)).status, 'failed');
    const second = await prompted(h, thread.id, 'two');
    assert.equal((await finished(h, thread.id, second)).status, 'completed');

    assert.equal(h.executor.callsOf('formats').length, 2);
    assert.equal(callsFor(h, 'run', thread.id).length, 1);
  });

  test('24: with no executor/v1 provider in the catalog the prompt fails unavailable and no executor/v1 call is made; with one, Get is called once across two prompts', async (t) => {
    const none = await routed(t, { executorProvider: null });
    const lonely = await readyThread(none);

    await prompted(none, lonely.thread.id, 'go');
    await eventually(
      () =>
        none.logs.some(({ fields }) => codeOf(fields?.err) === 'unavailable'),
      'the unavailable failure',
    );
    assert.deepEqual(none.executor.calls, []);

    const h = await routed(t);
    const { thread } = await readyThread(h);
    for (const prompt of ['one', 'two'])
      assert.equal(
        (await finished(h, thread.id, await prompted(h, thread.id, prompt)))
          .status,
        'completed',
      );
    assert.equal(callsOf(h, 'catalog.get').length, 1);
  });

  test("25: an executor failure reaches the prompt with the executor's code", async (t) => {
    const h = await routed(t, {
      execute: async () => {
        throw new ContractError('model_unavailable', 'The model is gone.');
      },
    });
    const { thread } = await readyThread(h);

    const promptId = await prompted(h, thread.id, 'go');

    assert.equal((await finished(h, thread.id, promptId)).status, 'failed');
    const failed = (await eventsOf(h, thread.id)).find(
      ({ type }) => type === 'agent.failed',
    );
    assert.equal(
      (failed?.event as { error?: { code?: unknown } } | undefined)?.error
        ?.code,
      'model_unavailable',
    );
  });
});

describe('S51b: runtime/executor and the routed executor', () => {
  test("B12: serveExecutor's Run receives the thread and job runtime's routed executor encoded, and a session whose callbacks reach runtime's executor.session/v1; the prompt finishes with its text", async (t) => {
    const received: { thread: unknown; job: unknown; seen: unknown[] }[] = [];
    let h: Harness | undefined;
    const served = serveExecutor(
      {
        run: async ({ thread, job, session }) => {
          const remote = session as RemotePromptSession;
          const seen: unknown[] = [remote.history.format];
          seen.push(await remote.history.read('messages'));
          seen.push(await remote.steers());
          seen.push(
            await remote.describeAttachment(`sha256-${'0'.repeat(64)}`),
          );
          await remote.record({
            history: { format: testHistoryFormat, parts: { messages: ['m1'] } },
            event: { type: 'text.delta', text: 'served' },
          });
          received.push({ thread, job, seen });

          return { text: `served ${job.prompt}` };
        },
        checkpoint: async () => ({ format: testHistoryFormat, parts: {} }),
        rewind: async () => undefined,
        formats: () => [testHistoryFormat],
        compact: async () => ({ status: 'refused', reason: 'disabled' }),
      },
      () => {
        assert.ok(h !== undefined, 'a session before the harness');

        return h.session();
      },
    );
    h = await routed(t, {
      executorOverrides: {
        run: (request, context) => served.run(request, context),
      },
    });
    const { thread } = await readyThread(h);

    const promptId = await prompted(h, thread.id, 'go');
    const outcome = await finished(h, thread.id, promptId);

    assert.deepEqual(
      { status: outcome.status, text: outcome.text },
      { status: 'completed', text: 'served go' },
    );
    const [call] = callsFor(h, 'run', thread.id);
    const request = call?.request as { thread?: unknown; job?: unknown };
    assert.equal(received.length, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(received[0]?.thread)),
      request.thread,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(received[0]?.job)), request.job);
    assert.deepEqual(received[0]?.seen, [undefined, undefined, [], undefined]);
    assert.deepEqual(await storedMessages(h, thread.id), ['m1']);
    const logged = (await eventsOf(h, thread.id)).find(
      ({ type }) => type === 'text.delta',
    )?.event as { text?: unknown } | undefined;
    assert.equal(logged?.text, 'served');
  });

  test("B19: an executor Run failing provider_error with valid details ends the prompt with agent.failed carrying the provider error's shape; malformed details keep the ContractError", async (t) => {
    const data = {
      provider: 'openrouter',
      code: 'rate_limit_error',
      message: 'Slow down.',
      status: 429,
      retryable: true,
    };
    let details: unknown = { providerError: data };
    const h = await routed(t, {
      execute: async () => {
        throw new ContractError('provider_error', 'Slow down.', details);
      },
    });
    const { thread } = await readyThread(h);
    const failedError = async () => {
      const promptId = await prompted(h, thread.id, 'go');
      assert.equal((await finished(h, thread.id, promptId)).status, 'failed');
      const failed = (await eventsOf(h, thread.id))
        .filter(({ type }) => type === 'agent.failed')
        .at(-1);

      return (failed?.event as { error?: Record<string, unknown> } | undefined)
        ?.error;
    };

    const rebuilt = await failedError();

    // What the chat's `errorInfo` reads of an in-process `ProviderErrorObject`:
    // `name` and `message` at the top, `code`, `provider`, `status` and
    // `retryable` under `data`, and no `code` of its own.
    assert.deepEqual(
      {
        name: rebuilt?.name,
        message: rebuilt?.message,
        code: rebuilt?.code,
        data: rebuilt?.data,
      },
      { name: 'ProviderError', message: 'Slow down.', code: undefined, data },
    );

    details = { providerError: { provider: 'openrouter', message: 'Bad.' } };
    const kept = await failedError();

    assert.equal(kept?.code, 'provider_error');
    assert.notEqual(kept?.name, 'ProviderError');
  });
});

describe('S48b: routedExecutor (port)', () => {
  test('18: checkpoint rejects invalid_output for a chunk first, a part without chunk, a part that is not JSON and an empty stream; rewind resolves undefined for an empty stream', async (t) => {
    let answer: readonly {
      item:
        | { case: 'format' | 'part'; value: string }
        | { case: 'chunk'; value: Uint8Array };
    }[] = [];
    const { context } = await contextHarness(t, {
      executor: 'routed',
      executorOverrides: {
        checkpoint: () => streamOf(answer),
        rewind: () => streamOf(answer),
      },
    });
    const executor = routedExecutor(
      context,
      createExecutorSessions(),
    )({
      projectId: randomUUID(),
      threadId: randomUUID(),
      promptId: randomUUID(),
    });
    const history: HistoryReader = {
      format: undefined,
      read: async () => undefined,
    };
    const [json] = encodeJson({ a: 1 });
    assert.ok(json !== undefined);
    const format = { case: 'format' as const, value: testHistoryFormat };
    const cases = [
      {
        what: 'a chunk first',
        items: [{ item: { case: 'chunk' as const, value: json } }],
      },
      {
        what: 'a part without chunk',
        items: [
          { item: format },
          { item: { case: 'part' as const, value: 'a' } },
          { item: { case: 'part' as const, value: 'b' } },
          { item: { case: 'chunk' as const, value: json } },
        ],
      },
      {
        what: 'a part that is not JSON',
        items: [
          { item: format },
          { item: { case: 'part' as const, value: 'a' } },
          {
            item: {
              case: 'chunk' as const,
              value: new TextEncoder().encode('not json'),
            },
          },
        ],
      },
      { what: 'an empty stream', items: [] },
    ];

    for (const { what, items } of cases) {
      answer = items;
      const error = await assertFails(
        Promise.resolve().then(() =>
          executor.checkpoint({ history, promptId: randomUUID() }),
        ),
        'invalid_output',
      );
      assert.ok(error.message.length > 0, what);
    }
    answer = [];
    assert.equal(
      await Promise.resolve().then(() =>
        executor.rewind({
          history,
          promptId: randomUUID(),
          removedPromptIds: [],
        }),
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// S51e (contract s51 §13): a prompt's executor call is cancelled through its
// session (`executor.session/v1.WatchCancel`), not by cancelling the call.
// ---------------------------------------------------------------------------

/** The `executor_cancel_timeout` warnings logged so far. */
const cancelTimeouts = (logs: Harness['logs']) =>
  logs.filter(
    ({ level, fields }) =>
      level === 'warn' && fields?.code === 'executor_cancel_timeout',
  );

/** Every item of a `WatchCancel` stream; rejects with its failure. */
const watchItems = async (h: Harness, sessionId: string, caller?: Caller) => {
  const items: unknown[] = [];
  for await (const item of h.session(caller).watchCancel({ sessionId })) {
    items.push(item);
  }

  return items;
};

/** The `Timeout`s keeping the process alive now. */
const activeTimeouts = () =>
  process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;

/** The last `agent.cancelled` event's `error` in Thread `id`'s log. */
const cancelledError = async (h: Harness, id: string) => {
  const cancelled = (await eventsOf(h, id))
    .filter(({ type }) => type === 'agent.cancelled')
    .at(-1);
  assert.ok(cancelled !== undefined, 'an agent.cancelled event');

  return (cancelled.event as { error?: Record<string, unknown> } | undefined)
    ?.error;
};

describe('S51e: a prompt cancelled through its executor session', () => {
  test('68 (E1): pausing a running prompt answers the executor WatchCancel item while its Run handler signal stays live; a Record made after the item is saved; the prompt ends once the Run resolved', async (t) => {
    const held = gate();
    const release = gate();
    t.after(() => {
      held.open();
      release.open();
    });
    let resolved = false;
    const h = await routed(t, {
      executorWatchCancel: true,
      execute: async (run) => {
        await holdUntil(held, run.signal);
        await run.append('after the cancel');
        await release.promise;
        resolved = true;

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);

    const paused = await h.threads().pause({ id: thread.id, promptId });

    assert.equal(paused.interruptResult, 'interrupted');
    await eventually(
      () => run.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    assert.equal(run.signal.aborted, false, "the Run's handler signal is live");
    await eventually(
      async () =>
        (await storedMessages(h, thread.id)).includes('after the cancel'),
      'the Record made after the item is saved',
    );
    assert.notEqual(
      (await threadOf(h, thread.id)).result?.promptId,
      promptId,
      'the prompt has not ended while its Run is in flight',
    );

    release.open();
    const result = await finished(h, thread.id, promptId);

    assert.ok(resolved, 'the prompt ended after the Run resolved');
    assert.equal(result.status, 'cancelled');
    assert.equal(run.watch?.items(), 1, 'one item');
  });

  test('69 (E2): interrupting a running prompt whose executor then fails run_cancelled ends agent.cancelled, status cancelled, text "The prompt was interrupted."; the error is the abort reason; the session answers unknown_session only after the Run settled', async (t) => {
    const held = gate();
    const release = gate();
    t.after(() => {
      held.open();
      release.open();
    });
    const h = await routed(t, {
      executorWatchCancel: true,
      execute: async (run) => {
        await holdUntil(held, run.signal);
        await release.promise;
        throw new ContractError('run_cancelled', 'The run was cancelled.');
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);

    await h.threads().pause({ id: thread.id, promptId });
    await eventually(
      () => run.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    // The session stays open while the Run is in flight.
    assert.deepEqual(
      (await h.session().takeSteers({ sessionId })).steers,
      [],
      'a callback still answers after the cancel',
    );

    release.open();
    const result = await finished(h, thread.id, promptId);

    assert.equal(result.status, 'cancelled');
    assert.equal(result.text, 'The prompt was interrupted.');
    const error = await cancelledError(h, thread.id);
    assert.equal(error?.name, 'AbortError', JSON.stringify(error));
    assert.notEqual(error?.code, 'run_cancelled');
    await assertUnknownSession(
      h.session().takeSteers({ sessionId }),
      'after the Run settled',
    );
  });

  test('70 (E3): an executor that resolves {text: "late"} after the cancel leaves the prompt cancelled, its text not "late"', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const returned: { at?: number } = {};
    const h = await routed(t, {
      executorWatchCancel: true,
      executorCancelGraceMs: 200,
      execute: async (run) => {
        await holdUntil(held, run.signal);
        returned.at = performance.now();

        return 'late';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);
    const aborted: { at?: number } = {};
    run.signal.addEventListener(
      'abort',
      () => {
        aborted.at = performance.now();
      },
      { once: true },
    );

    await h.threads().pause({ id: thread.id, promptId });
    await eventually(
      () => run.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    const result = await finished(h, thread.id, promptId);

    assert.equal(result.status, 'cancelled');
    assert.notEqual(result.text, 'late');
    assert.ok(returned.at !== undefined, 'the Run answered');
    // Connect aborts a unary handler's signal when its call ends (C-E2):
    // only an abort before the Run answered would be a cancel.
    assert.ok(
      aborted.at === undefined || aborted.at >= returned.at,
      'the Run call was not cancelled before it answered',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(cancelTimeouts(h.logs), [], 'no executor_cancel_timeout');
  });

  test('71 (E4): a WatchCancel opened after the cancel answers its item at once; one opened on a run that finishes uncancelled ends with no item when the Run settles', async (t) => {
    const held = gate();
    const late = gate();
    t.after(() => {
      held.open();
      late.open();
    });
    const h = await routed(t, {
      executorWatchCancel: true,
      executorWatchCancelAfter: () => late.promise,
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);

    await h.threads().pause({ id: thread.id, promptId });
    late.open();

    await eventually(
      () => run.watch?.items() === 1,
      'the late WatchCancel answered its item',
      1_000,
    );
    assert.ok(run.watch !== undefined);
    assert.deepEqual(await within(run.watch.ended, 'the late watch'), {
      ok: true,
    });

    const quick = await routed(t, {
      executorWatchCancel: true,
      execute: async () => {
        await settle();

        return 'done';
      },
    });
    const other = await readyThread(quick);
    const quickPrompt = await prompted(quick, other.thread.id, 'go');
    assert.equal(
      (await finished(quick, other.thread.id, quickPrompt)).status,
      'completed',
    );
    const [uncancelled] = callsFor(quick, 'run', other.thread.id);
    assert.ok(uncancelled?.watch !== undefined);
    assert.deepEqual(
      await within(uncancelled.watch.ended, 'the uncancelled watch'),
      { ok: true },
    );
    assert.equal(uncancelled.watch.items(), 0, 'no item');
  });

  test('72 (E5): WatchCancel with another bundle, another instance after the first callback, or an ended id fails NOT_FOUND unknown_session (T3.3)', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const h = await routed(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    const sessionId = await runSession(h, thread.id);

    await assertUnknownSession(
      watchItems(h, sessionId, otherBundle),
      'another bundle',
    );
    await h.session().takeSteers({ sessionId });
    await assertUnknownSession(
      watchItems(h, sessionId, nextGeneration),
      'another instance after the first callback',
    );

    held.open();
    await finished(h, thread.id, promptId);
    await assertUnknownSession(watchItems(h, sessionId), 'an ended id');
  });

  test('73 (E6): an executor that honours the cancel within the grace logs no warning, its Run is never cancelled, and the grace timer keeps nothing alive', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const returned: { at?: number } = {};
    const h = await routed(t, {
      executorWatchCancel: true,
      executorCancelGraceMs: 200,
      execute: async (run) => {
        await holdUntil(held, run.signal);
        returned.at = performance.now();

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const promptId = await prompted(h, thread.id, 'hold');
    await runSession(h, thread.id);
    const [run] = callsFor(h, 'run', thread.id);
    assert.ok(run !== undefined);
    const aborted: { at?: number } = {};
    run.signal.addEventListener(
      'abort',
      () => {
        aborted.at = performance.now();
      },
      { once: true },
    );
    const timeoutsBefore = activeTimeouts();

    await h.threads().pause({ id: thread.id, promptId });
    await eventually(
      () => run.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    await finished(h, thread.id, promptId);

    assert.ok(
      activeTimeouts() <= timeoutsBefore,
      'no grace timer keeps the process alive after the prompt ended',
    );
    assert.ok(returned.at !== undefined, 'the Run resolved');
    assert.ok(
      aborted.at === undefined || aborted.at >= returned.at,
      'the Run call was not cancelled before it answered',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(cancelTimeouts(h.logs), [], 'no executor_cancel_timeout');
  });
});

/** A Thread of `scope` as an executor receives it. */
const executorThreadOf = (scope: {
  projectId: string;
  threadId: string;
  promptId: string;
}): ExecutorThread => ({
  id: scope.threadId,
  projectId: scope.projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 1,
  cwd: '/workspace',
  createdAt: epoch,
  updatedAt: epoch,
  model: 'm-1',
  effort: 'low',
});

/** The signal of a `compact` call argument, if any. */
const signalOfArg = (call: unknown): AbortSignal | undefined =>
  typeof call === 'object' && call !== null && 'signal' in call
    ? (call as { signal?: AbortSignal }).signal
    : undefined;

/**
 * `routedExecutor(context, sessions, {cancelGraceMs})` (50 ms unless given) over a router
 * whose bundle serves `executor.session/v1` for `sessions`, with the fake
 * executor's `compact`; the session `compact` is given records each event.
 */
const directCompaction = async (
  t: Parameters<typeof started>[0],
  options: Pick<HarnessOptions, 'compact' | 'executorWatchCancel'>,
  cancelGraceMs = 50,
) => {
  const sessions = createExecutorSessions();
  const harnessed = await contextHarness(t, {
    executor: 'routed',
    ...options,
    services: [
      [SessionService, routedSessionService(sessions)] as ServiceEntry,
    ],
  });
  const scope = {
    projectId: randomUUID(),
    threadId: randomUUID(),
    promptId: randomUUID(),
  };
  const executor = routedExecutor(harnessed.context, sessions, {
    cancelGraceMs,
  })(scope);
  const recorded: unknown[] = [];
  const session: PromptSession = {
    history: { format: undefined, read: async () => undefined },
    record: async ({ event }) => {
      recorded.push(event);
    },
  };
  const controller = new AbortController();
  const state: { settled: boolean } = { settled: false };
  const compacting = executor
    .compact(
      {
        thread: executorThreadOf(scope),
        session,
        policy: { tailMinMessages: 4, summaryMaxChars: 2000 },
      },
      { signal: controller.signal },
    )
    .finally(() => {
      state.settled = true;
    });
  // Observed by each test; never an unhandled rejection.
  compacting.catch(() => undefined);
  await eventually(
    () => harnessed.executor.callsOf('compact').length === 1,
    'the Compact call',
  );
  const [call] = harnessed.executor.callsOf('compact');
  assert.ok(call !== undefined);

  return {
    ...harnessed,
    call,
    compacting,
    controller,
    recorded,
    state,
  };
};

describe('S51e: routedExecutor compact cancelled through its session (port)', () => {
  test('82 (E12): compact aborted while Compact is in flight answers the WatchCancel item, leaves the Compact handler signal live, applies a Record made after the item, settles only after Compact did; a callback afterwards is unknown_session', async (t) => {
    const release = gate();
    t.after(() => release.open());
    // A grace long enough that the waits below stay inside it (C-E3).
    const d = await directCompaction(
      t,
      {
        executorWatchCancel: true,
        compact: async (input, call) => {
          await holdUntil(gate(), signalOfArg(call));
          await input.session.record({
            event: { type: 'compaction.failed', code: 'summarizer_failed' },
          });
          await release.promise;

          return { status: 'failed', code: 'summarizer_failed' };
        },
      },
      10_000,
    );

    d.controller.abort();
    await eventually(
      () => d.call.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    assert.equal(
      d.call.signal.aborted,
      false,
      "the Compact handler's signal is live",
    );
    await eventually(
      () => d.recorded.length === 1,
      'the Record made after the item is applied',
    );
    assert.deepEqual(d.recorded, [
      { type: 'compaction.failed', code: 'summarizer_failed' },
    ]);
    await settle();
    assert.equal(d.state.settled, false, 'compact waits for Compact');

    release.open();
    await d.compacting.catch(() => undefined);
    await assertFails(
      Promise.resolve().then(() =>
        d.executor.remote(sessionIdOf(d.call)).steers?.(),
      ),
      'unknown_session',
    );
  });

  test('83 (E13): after the abort, a Compact resolving {status: failed, code: summarizer_failed} resolves that result; one rejecting compaction_cancelled rejects with the signal reason', async (t) => {
    const failed: ExecutorCompactionResult = {
      status: 'failed',
      code: 'summarizer_failed',
    };
    const resolving = await directCompaction(t, {
      executorWatchCancel: true,
      compact: async (_input, call) => {
        await holdUntil(gate(), signalOfArg(call));

        return failed;
      },
    });

    resolving.controller.abort();
    await eventually(
      () => resolving.call.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    assert.deepEqual(
      await within(resolving.compacting, 'compact'),
      failed,
      'the resolved result is answered',
    );

    const rejecting = await directCompaction(t, {
      executorWatchCancel: true,
      compact: async (_input, call) => {
        await holdUntil(gate(), signalOfArg(call));
        throw new ContractError(
          'compaction_cancelled',
          'The compaction was cancelled.',
        );
      },
    });
    const reason = new Error('the prompt was cancelled');

    rejecting.controller.abort(reason);
    await eventually(
      () => rejecting.call.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    assert.equal(
      await rejectionOf(rejecting.compacting),
      reason,
      'compact rejects with the signal reason',
    );
  });

  test('84 (E14): an executor that ignores WatchCancel has its Compact cancelled >= 50 ms after the abort with one executor_cancel_timeout warning; one that honours it in time logs nothing and is never cancelled', async (t) => {
    const ignoring = await directCompaction(t, {
      compact: async (_input, call) => {
        await holdUntil(gate(), signalOfArg(call));

        return { status: 'refused', reason: 'nothing_to_compact' };
      },
    });
    const aborted: { at?: number } = {};
    ignoring.call.signal.addEventListener(
      'abort',
      () => {
        aborted.at = performance.now();
      },
      { once: true },
    );

    const abortAt = performance.now();
    ignoring.controller.abort();
    await eventually(
      () => ignoring.call.signal.aborted,
      'the Compact call cancelled',
    );
    const cancelledAt = aborted.at;
    assert.ok(cancelledAt !== undefined);
    // ≥ 50 ms, with 1 ms of timer granularity.
    assert.ok(
      cancelledAt - abortAt >= 49,
      `the Compact call was cancelled ${(cancelledAt - abortAt).toFixed(1)} ms after the abort, not after the 50 ms grace`,
    );
    await ignoring.compacting.catch(() => undefined);
    assert.deepEqual(
      cancelTimeouts(ignoring.logs).map(({ message }) => message),
      ['The executor did not end a cancelled compaction.'],
    );

    const returned: { at?: number } = {};
    const honouring = await directCompaction(t, {
      executorWatchCancel: true,
      compact: async (_input, call) => {
        await holdUntil(gate(), signalOfArg(call));
        returned.at = performance.now();

        return { status: 'refused', reason: 'nothing_to_compact' };
      },
    });
    const honouredAbort: { at?: number } = {};
    honouring.call.signal.addEventListener(
      'abort',
      () => {
        honouredAbort.at = performance.now();
      },
      { once: true },
    );

    honouring.controller.abort();
    await eventually(
      () => honouring.call.watch?.items() === 1,
      "the executor's WatchCancel answered its item",
    );
    await honouring.compacting.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(returned.at !== undefined, 'the Compact answered');
    assert.ok(
      honouredAbort.at === undefined || honouredAbort.at >= returned.at,
      'the Compact call was not cancelled before it answered',
    );
    assert.deepEqual(cancelTimeouts(honouring.logs), []);
  });
});
