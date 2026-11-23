// `runtime/executor` (phase 3, slice S51b, contract §4.5, tests B12-B18):
// `serveExecutor` served by a bundle under test in a test router, its
// sessions calling back a recording fake `executor.session/v1`, and
// `historyPatchItems` read back by S48's `historyPatchOf`. The round trip
// with runtime's own routed executor as the caller (B12) is in
// `executor.test.ts`.

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import {
  create,
  fromBinary,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import {
  type Client,
  Code,
  ConnectError,
  createHandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  deadlineOf,
  fromConnectError,
  isCall,
  isContractError,
} from 'bundle/contracts';
import type { HostContext } from 'bundle/host';
import { createTestRouter, type TestClientOptions } from 'bundle/testing';
import { decodeJson, encodeJson } from 'storage/rpc';

import type { Attachment } from '../../src/contracts/attachments.js';
import type {
  CompactionPolicyValue,
  ExecutorCompactionResult,
  ExecutorThread,
  HistoryPatch,
  PromptJob,
  SteerInput,
} from '../../src/contracts/executor.js';
import {
  type RecordRequestSchema,
  SessionService,
  SteerInputSchema,
} from '../../src/contracts/gen/doric/executor/session/v1/session_pb.js';
import {
  CompactRequestSchema,
  CompactResponseSchema,
  ExecutorService,
  ExecutorThreadSchema,
  PromptJobSchema,
  RunRequestSchema,
} from '../../src/contracts/gen/doric/executor/v1/executor_pb.js';
import {
  type ExecutorImplementation,
  historyPatchItems,
  type RemotePromptSession,
  serveExecutor,
} from '../../src/executor.js';
import { decode, encode, runtimeOneofs } from '../../src/host/rpc/codec.js';
import { historyPatchOf } from '../../src/host/rpc/history.js';

const MiB = 1024 * 1024;
const format = 'test.history/v1';
const sessionId = 'session-1';
const projectId = '00000000-0000-4000-8000-000000000001';
const threadId = '00000000-0000-4000-8000-000000000002';
const promptId = '00000000-0000-4000-8000-000000000003';
const at = '2026-11-23T12:00:00.000Z';
const attachmentId = `sha256-${'a'.repeat(64)}`;

const thread: ExecutorThread = {
  id: threadId,
  projectId,
  name: 'Thread',
  state: 'running',
  lastSequence: 2,
  cwd: '/workspace',
  activePromptId: promptId,
  createdAt: at,
  updatedAt: at,
  model: 'm-1',
  effort: 'low',
  agent: { name: 'reviewer', source: 'workspace', instructions: 'Review.' },
};

const job: PromptJob = { id: promptId, prompt: 'go', source: { kind: 'user' } };

const runRequest = (value: unknown = thread) => ({
  sessionId,
  thread: encode(ExecutorThreadSchema, value, runtimeOneofs),
  job: encode(PromptJobSchema, job, runtimeOneofs),
});

/** The value as JSON carries it. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// The fake `executor.session/v1`.
// ---------------------------------------------------------------------------

type RecordItem = MessageShape<typeof RecordRequestSchema>['item'];

interface SessionState {
  /** Every call, in order. */
  readonly calls: { readonly method: string; readonly sessionId: string }[];
  /** The parts `ReadHistory` reads, in the call order. */
  readonly reads: string[];
  /** The format every `ReadHistory` head carries; none when undefined. */
  format: string | undefined;
  /** The stored parts. */
  readonly parts: Map<string, unknown>;
  /** The items of each `Record`, in order. */
  readonly records: RecordItem[][];
  /** The next `Record` fails with this, after reading its items. */
  recordFailure?: ContractError;
  /** What `TakeSteers` answers. */
  steers: readonly SteerInput[];
  /** What `DescribeAttachment` answers, by id. */
  readonly attachments: Map<string, Attachment>;
  /**
   * S51e: how `WatchCancel` answers — `hold` (the default) until {@link cancelWatches} or the call is cancelled,
   * `unimplemented` (UNIMPLEMENTED), or `end` (ends at once with no item).
   */
  watchMode: 'hold' | 'unimplemented' | 'end';
  /** Every `WatchCancel` received: its session, handler signal and how many other session calls preceded it. */
  readonly watches: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly after: number;
  }[];
  /** The held `WatchCancel`s, each answering its item when called. */
  readonly held: Set<() => void>;
  /** The trace id and deadline of each `TakeSteers` call (the hop's `Call`). */
  readonly hops: { readonly traceId: string; readonly deadline: number }[];
}

/** The trace id of a `traceparent` (`00-<trace id>-<span id>-<flags>`). */
const traceIdOf = (call: Call): string =>
  call.trace.traceparent.split('-')[1] ?? '';

/** Answers the item of every held `WatchCancel` (a cancel through the session). */
const cancelWatches = (state: SessionState) => {
  for (const answer of [...state.held]) answer();
};

const sessionFake = (state: SessionState): ServiceImpl<typeof SessionService> =>
  ({
    readHistory: async function* (request) {
      state.calls.push({ method: 'readHistory', sessionId: request.sessionId });
      state.reads.push(request.part);
      yield {
        item: {
          case: 'head' as const,
          value: state.format === undefined ? {} : { format: state.format },
        },
      };
      const value = state.parts.get(request.part);

      if (value !== undefined) {
        for (const chunk of encodeJson(value)) {
          yield { item: { case: 'chunk' as const, value: chunk } };
        }
      }
    },
    record: async (requests) => {
      const items: RecordItem[] = [];

      for await (const { item } of requests) {
        items.push(item);
      }

      const head = items[0];

      state.calls.push({
        method: 'record',
        sessionId: head?.case === 'head' ? head.value.sessionId : '',
      });
      state.records.push(items);

      const failure = state.recordFailure;

      if (failure !== undefined) {
        state.recordFailure = undefined;
        throw failure;
      }

      return {};
    },
    takeSteers: async (request, context) => {
      state.calls.push({ method: 'takeSteers', sessionId: request.sessionId });
      const hop = callOf(context);
      state.hops.push({ traceId: traceIdOf(hop), deadline: deadlineOf(hop) });

      return {
        steers: state.steers.map((steer) =>
          encode(SteerInputSchema, steer, runtimeOneofs),
        ),
      };
    },
    describeAttachment: async (request) => {
      state.calls.push({
        method: 'describeAttachment',
        sessionId: request.sessionId,
      });
      const attachment = state.attachments.get(request.id);

      return attachment === undefined ? {} : { attachment };
    },
    watchCancel: async function* (request, context) {
      state.watches.push({
        sessionId: request.sessionId,
        signal: context.signal,
        after: state.calls.length,
      });
      if (state.watchMode === 'unimplemented')
        throw new ConnectError(
          'WatchCancel is not served.',
          Code.Unimplemented,
        );
      if (state.watchMode === 'end') return;
      const cancelled = await new Promise<boolean>((resolve) => {
        const answer = () => {
          state.held.delete(answer);
          resolve(true);
        };
        state.held.add(answer);
        context.signal.addEventListener(
          'abort',
          () => {
            state.held.delete(answer);
            resolve(false);
          },
          { once: true },
        );
      });
      if (cancelled) yield {};
    },
  }) satisfies ServiceImpl<typeof SessionService>;

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

const unexpected = (method: string) => () => {
  throw new Error(`Unexpected ${method}.`);
};

interface Served {
  readonly client: Client<typeof ExecutorService>;
  /** A client with its own caller or scope. */
  readonly clientOf: (
    options: TestClientOptions,
  ) => Client<typeof ExecutorService>;
  readonly state: SessionState;
}

/** `serveExecutor(implementation, …)` as the bundle under test, its sessions over the fake. */
const serve = async (
  t: TestContext,
  implementation: Partial<ExecutorImplementation>,
): Promise<Served> => {
  const state: SessionState = {
    calls: [],
    reads: [],
    format: undefined,
    parts: new Map(),
    records: [],
    steers: [],
    attachments: new Map(),
    watchMode: 'hold',
    watches: [],
    held: new Set(),
    hops: [],
  };
  const router = createTestRouter({
    fakes: [[SessionService, sessionFake(state)]],
  });
  let context: HostContext | undefined;
  const session = () => {
    assert.ok(context !== undefined, 'a session before activate');

    return context.services.use(SessionService);
  };

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ExecutorService,
        serveExecutor(
          {
            run: unexpected('run'),
            checkpoint: unexpected('checkpoint'),
            rewind: unexpected('rewind'),
            formats: unexpected('formats'),
            compact: unexpected('compact'),
            ...implementation,
          },
          session,
        ),
      ],
    ],
    activate: (activated) => {
      context = activated;
    },
  });

  return {
    client: router.client(ExecutorService),
    clientOf: (options) => router.client(ExecutorService, options),
    state,
  };
};

/** Waits until `ready()` holds; fails after 5 s. */
const eventually = async (
  ready: () => boolean,
  what: string,
): Promise<void> => {
  const deadline = performance.now() + 5_000;

  while (!ready()) {
    if (performance.now() > deadline)
      assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Resolves once `signal` aborted (at once when it already is). */
const abortedOf = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

const drain = async <T>(items: AsyncIterable<T>): Promise<T[]> => {
  const all: T[] = [];

  for await (const item of items) {
    all.push(item);
  }

  return all;
};

/** The Doric error a failed call carries. */
const failureOf = async (promise: Promise<unknown>): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectError, String(error));

    return fromConnectError(error);
  }

  assert.fail('expected the call to fail');
};

/** Each `Record` item as `{case, value}` with chunks of one part joined and decoded. */
const recordShape = (items: readonly RecordItem[]): unknown[] => {
  const shape: unknown[] = [];
  let chunks: Uint8Array[] = [];
  const flush = () => {
    if (chunks.length > 0) {
      shape.push({ chunks: decodeJson(chunks, 'invalid_output') });
      chunks = [];
    }
  };

  for (const item of items) {
    if (item.case === 'chunk') {
      chunks.push(item.value);
      continue;
    }

    flush();

    if (item.case === 'head') {
      shape.push({
        head: {
          sessionId: item.value.sessionId,
          format: item.value.format,
        },
      });
    } else if (item.case === 'part') {
      shape.push({ part: item.value });
    } else if (item.case === 'event') {
      shape.push({ event: item.value });
    }
  }

  flush();

  return shape;
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('S51b: runtime/executor', () => {
  test("B12 (S51e): Run gives the implementation the decoded thread and job, a call with the handler call's caller, scope, trace and deadline whose signal aborts with the handler's, and a session for the request sessionId; answers {text}", async (t) => {
    const caller = { bundleId: 'runtime', version: '1.0.0', generation: 1 };
    const scope = { projectId, threadId, promptId };
    const received: {
      thread: unknown;
      job: unknown;
      call: Call;
    }[] = [];
    const { clientOf, state } = await serve(t, {
      run: async (input, call) => {
        received.push({ thread: input.thread, job: input.job, call });
        await input.session.steers?.();
        if (input.job.prompt === 'hold') await abortedOf(call.signal);

        return { text: 'answer' };
      },
    });
    const client = clientOf({ caller, scope });

    const response = await client.run(runRequest(), { timeoutMs: 60_000 });

    assert.equal(response.text, 'answer');
    assert.equal(received.length, 1);
    const [first] = received;
    assert.ok(first !== undefined);
    assert.deepEqual(plain(first.thread), plain(thread));
    assert.deepEqual(plain(first.job), plain(job));
    assert.ok(isCall(first.call), 'isCall holds');
    assert.deepEqual(plain(first.call.caller), caller);
    assert.deepEqual(plain(first.call.scope), scope);
    // The session call is a hop of the handler's call: same trace, same deadline.
    const [hop] = state.hops;
    assert.ok(hop !== undefined);
    assert.equal(traceIdOf(first.call), hop.traceId);
    assert.ok(deadlineOf(first.call) > 0, 'the deadline carried');
    assert.equal(deadlineOf(first.call), hop.deadline);
    assert.deepEqual(state.calls, [{ method: 'takeSteers', sessionId }]);
    assert.deepEqual(
      state.watches.map((watch) => watch.sessionId),
      [sessionId],
      'Run opened WatchCancel for its session',
    );

    // The implementation's signal aborts when the handler's does.
    const controller = new AbortController();
    const held = client.run(
      {
        ...runRequest(),
        job: encode(PromptJobSchema, { ...job, prompt: 'hold' }, runtimeOneofs),
      },
      { signal: controller.signal },
    );
    held.catch(() => undefined);
    await eventually(() => received.length === 2, 'the second run');
    controller.abort();
    await eventually(
      () => received[1]?.call.signal.aborted === true,
      "the implementation's signal aborted with the handler's",
    );
  });

  test('B13: history.read joins and decodes the chunks, answers undefined for none; history.format is undefined before the first read and the head format after it', async (t) => {
    const messages = [{ role: 'user', text: 'x'.repeat(2.5 * MiB) }];
    const seen: unknown[] = [];
    const { client, state } = await serve(t, {
      run: async ({ session }) => {
        seen.push(session.history.format);
        seen.push(await session.history.read('messages'));
        seen.push(session.history.format);
        seen.push(await session.history.read('absent'));

        return { text: 'done' };
      },
    });
    state.format = format;
    state.parts.set('messages', messages);

    await client.run(runRequest());

    assert.ok(encodeJson(messages).length >= 3, 'several chunks');
    assert.deepEqual(seen, [undefined, messages, format, undefined]);
    assert.deepEqual(state.reads, ['messages', 'absent']);
    assert.deepEqual(
      state.calls.map((call) => call.sessionId),
      [sessionId, sessionId],
    );
  });

  test('B14: record streams head{sessionId, format}, each part and its chunks, then the event; without history the head has no format; a Record failing unavailable rejects unavailable', async (t) => {
    const patch: HistoryPatch = {
      format,
      parts: { messages: ['m1', 'y'.repeat(1.5 * MiB)], meta: { turns: 1 } },
    };
    const outcomes: unknown[] = [];
    const box: { served?: Served } = {};
    const served = await serve(t, {
      run: async ({ session }) => {
        await session.record({
          history: patch,
          event: { type: 'text.delta', text: 'kept' },
        });
        await session.record({ event: { type: 'agent.steered' } });
        assert.ok(box.served !== undefined);
        box.served.state.recordFailure = new ContractError(
          'unavailable',
          'The history write failed.',
        );
        outcomes.push(
          await session.record({ history: patch }).then(
            () => 'resolved',
            (error: unknown) => error,
          ),
        );

        return { text: 'done' };
      },
    });
    box.served = served;
    const { client, state } = served;

    await client.run(runRequest());

    assert.deepEqual(recordShape(state.records[0] ?? []), [
      { head: { sessionId, format } },
      { part: 'messages' },
      { chunks: patch.parts.messages },
      { part: 'meta' },
      { chunks: { turns: 1 } },
      { event: { type: 'text.delta', text: 'kept' } },
    ]);
    assert.ok(
      (state.records[0] ?? []).every(
        (item) => item.case !== 'chunk' || item.value.length <= MiB,
      ),
      'chunks of at most 1 MiB',
    );
    assert.deepEqual(recordShape(state.records[1] ?? []), [
      { head: { sessionId, format: undefined } },
      { event: { type: 'agent.steered' } },
    ]);
    const [failure] = outcomes;
    assert.ok(isContractError(failure), String(failure));
    assert.equal(failure.code, 'unavailable');
  });

  test('B15: steers decode the InputSource oneof; describeAttachment answers {id, name, mediaType, size} without bytes, undefined for none; the session has no attachment', async (t) => {
    const steers: SteerInput[] = [
      { prompt: 'more', source: { kind: 'user' } },
      {
        prompt: 'child done',
        source: {
          kind: 'result',
          threadId: 'child',
          promptId: 'child-prompt',
          requestPromptId: promptId,
        },
      },
      {
        prompt: 'terminal output',
        source: { kind: 'terminal', terminalId: 'term', promptId },
      },
    ];
    const attachment: Attachment = {
      id: attachmentId,
      name: 'cat.png',
      mediaType: 'image/png',
      size: 1234,
    };
    const seen: unknown[] = [];
    const { client, state } = await serve(t, {
      run: async ({ session }) => {
        const remote = session as RemotePromptSession;

        seen.push(await remote.steers());
        seen.push(await remote.describeAttachment(attachmentId));
        seen.push(await remote.describeAttachment(`sha256-${'b'.repeat(64)}`));
        seen.push(remote.attachment);

        return { text: 'done' };
      },
    });
    state.steers = steers;
    state.attachments.set(attachmentId, attachment);

    await client.run(runRequest());

    assert.deepEqual(plain(seen[0]), plain(steers));
    assert.deepEqual(seen[1], attachment);
    assert.equal(seen[2], undefined);
    assert.equal(seen[3], undefined);
    assert.deepEqual(
      state.calls.map(({ method, sessionId: id }) => ({ method, id })),
      [
        { method: 'takeSteers', id: sessionId },
        { method: 'describeAttachment', id: sessionId },
        { method: 'describeAttachment', id: sessionId },
      ],
    );
  });

  test('B16: historyPatchItems streams format, then each part and its chunks of at most 1 MiB; historyPatchOf reads back an equal patch, a 3 MiB part included', async (t) => {
    const patch: HistoryPatch = {
      format,
      parts: { messages: 'z'.repeat(3 * MiB), meta: { turns: 2 }, empty: [] },
    };

    const items = historyPatchItems(patch);

    assert.deepEqual(items[0], { item: { case: 'format', value: format } });
    const cases = items.map(({ item }) => item?.case);
    const partsAt = cases.flatMap((name, index) =>
      name === 'part' ? [index] : [],
    );
    assert.deepEqual(
      partsAt.map((index) => items[index]?.item?.value),
      ['messages', 'meta', 'empty'],
    );
    for (const [position, index] of partsAt.entries()) {
      assert.equal(cases[index + 1], 'chunk', 'at least one chunk per part');
      const next = partsAt[position + 1] ?? items.length;
      assert.ok(
        cases.slice(index + 1, next).every((name) => name === 'chunk'),
        'only chunks between parts',
      );
    }
    const chunks = items.flatMap(({ item }) =>
      item?.case === 'chunk' ? [item.value as Uint8Array] : [],
    );
    assert.ok(chunks.every((chunk) => chunk.length <= MiB && chunk.length > 0));
    assert.ok(
      (partsAt[1] ?? 0) - (partsAt[0] ?? 0) - 1 >= 3,
      'the 3 MiB part travels in several chunks',
    );
    assert.deepEqual(historyPatchItems(undefined), []);

    const received: { promptId: string; format: string | undefined }[] = [];
    const { client } = await serve(t, {
      checkpoint: async ({ history, promptId: id }) => {
        received.push({ promptId: id, format: history.format });

        return patch;
      },
    });

    assert.deepEqual(
      await historyPatchOf(client.checkpoint({ sessionId, promptId })),
      patch,
    );
    assert.deepEqual(received, [{ promptId, format: undefined }]);
  });

  test('B17: Rewind answering undefined streams no item; the implementation gets the promptId and removedPromptIds', async (t) => {
    const received: { promptId: string; removed: readonly string[] }[] = [];
    const { client } = await serve(t, {
      rewind: async ({ promptId: id, removedPromptIds }) => {
        received.push({ promptId: id, removed: removedPromptIds });

        return undefined;
      },
    });

    const items = await drain(
      client.rewind({
        sessionId,
        promptId,
        removedPromptIds: ['p1', 'p2'],
      }),
    );

    assert.deepEqual(items, []);
    assert.deepEqual(plain(received), [{ promptId, removed: ['p1', 'p2'] }]);
  });

  test('B18: Formats answers the list without any session call; Compact answers the result encoded', async (t) => {
    const result: ExecutorCompactionResult = {
      status: 'compacted',
      summaryId: 'summary-1',
      condensedMessages: 3,
      retainedMessages: 2,
      tokensFreed: 100,
    };
    const policy: CompactionPolicyValue = {
      tailMinMessages: 4,
      summaryMaxChars: 2000,
    };
    const compacted: unknown[] = [];
    const { client, state } = await serve(t, {
      formats: () => ['test.history/v1', 'test.history/v2'],
      compact: async (input) => {
        compacted.push({ thread: input.thread, policy: input.policy });

        return result;
      },
    });

    const { formats } = await client.formats({});

    assert.deepEqual(formats, ['test.history/v1', 'test.history/v2']);
    assert.deepEqual(state.calls, []);

    const response = await client.compact({
      sessionId,
      thread: encode(ExecutorThreadSchema, thread, runtimeOneofs),
      policy,
    });

    assert.deepEqual(
      decode(CompactResponseSchema, response, runtimeOneofs),
      plain(result),
    );
    assert.deepEqual(plain(compacted), [
      { thread: plain(thread), policy: plain(policy) },
    ]);
  });

  test('B18: a thrown ContractError passes unchanged, a plain Error answers internal, and a Run whose thread breaks executorThreadSchema fails invalid_input before the implementation runs', async (t) => {
    let failure: unknown = new ContractError('model_unavailable', 'Gone.');
    let runs = 0;
    const { client } = await serve(t, {
      run: async () => {
        runs += 1;
        throw failure;
      },
    });

    const passed = await failureOf(client.run(runRequest()));
    assert.equal(passed.code, 'model_unavailable');
    assert.equal(passed.message, 'Gone.');

    failure = new Error('boom');
    const internal = await failureOf(client.run(runRequest()));
    assert.equal(internal.code, 'internal');

    assert.equal(runs, 2);

    // The router's protovalidate mirrors `executorThreadSchema`, so the request
    // reaches the served handler directly: a `state` the proto's string
    // carries through a binary round trip, which `threadStateSchema` rejects.
    const implementation = serveExecutor(
      {
        run: async () => {
          runs += 1;

          return { text: 'ran' };
        },
      } as Partial<ExecutorImplementation> as ExecutorImplementation,
      () => assert.fail('no session call before the implementation runs'),
    );
    const request = fromBinary(
      RunRequestSchema,
      toBinary(
        RunRequestSchema,
        create(RunRequestSchema, runRequest({ ...thread, state: 'paused' })),
      ),
    );
    const context = createHandlerContext({
      service: ExecutorService,
      method: ExecutorService.method.run,
      protocolName: 'test',
      requestMethod: 'POST',
      url: 'http://test/doric.executor.v1.ExecutorService/Run',
    });
    const invalid = await Promise.resolve()
      .then(() => implementation.run(request, context))
      .then(
        () => assert.fail('expected Run to fail'),
        (error: unknown) => error,
      );

    assert.ok(isContractError(invalid), String(invalid));
    assert.equal(invalid.code, 'invalid_input');
    assert.deepEqual(
      (invalid.details as { issues?: { path: unknown[] }[] }).issues?.map(
        ({ path }) => path,
      ),
      [['state']],
    );
    assert.equal(runs, 2, 'the implementation did not run');
  });
});

// ---------------------------------------------------------------------------
// S51e (contract s51 §13.4): `Run` and `Compact` watch their session's
// cancellation (`executor.session/v1.WatchCancel`).
// ---------------------------------------------------------------------------

const compactPolicy: CompactionPolicyValue = {
  tailMinMessages: 4,
  summaryMaxChars: 2000,
};

const compactRequest = (value: unknown = thread) => ({
  sessionId,
  thread: encode(ExecutorThreadSchema, value, runtimeOneofs),
  policy: compactPolicy,
});

/** The gRPC code and Doric error of a failed executor call. */
const rejectionOfRun = async (
  promise: Promise<unknown>,
): Promise<{ grpc: Code; error: ContractError }> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectError, String(error));

    return { grpc: error.code, error: fromConnectError(error) };
  }

  assert.fail('expected the call to fail');
};

/** A served `Run`'s handler context, the request decoded from the wire as the router delivers it. */
const directContext = (method: 'run' | 'compact') =>
  createHandlerContext({
    service: ExecutorService,
    method: ExecutorService.method[method],
    protocolName: 'test',
    requestMethod: 'POST',
    url: `http://test/doric.executor.v1.ExecutorService/${method}`,
  });

/** What the implementation's `call` saw: its signal's reason once aborted. */
interface Seen {
  call?: Call;
  reason?: unknown;
}

describe('S51e: serveExecutor watches the session for a cancel', () => {
  test('74 (E7): Run opens WatchCancel{sessionId} before any other session call; a Run failing invalid_input opens none; Checkpoint, Rewind and Formats open none', async (t) => {
    const { client, state } = await serve(t, {
      run: async (input) => {
        await input.session.steers?.();

        return { text: 'ran' };
      },
      checkpoint: async () => ({ format, parts: {} }),
      rewind: async () => undefined,
      formats: () => [format],
    });

    await client.run(runRequest());

    assert.deepEqual(
      state.watches.map(({ sessionId: id, after }) => ({ id, after })),
      [{ id: sessionId, after: 0 }],
      'WatchCancel first, for the request session',
    );

    await drain(client.checkpoint({ sessionId, promptId }));
    await drain(
      client.rewind({ sessionId, promptId, removedPromptIds: ['p1'] }),
    );
    await client.formats({});
    assert.equal(state.watches.length, 1, 'no WatchCancel for the others');

    const implementation = serveExecutor(
      {
        run: async () => ({ text: 'ran' }),
      } as Partial<ExecutorImplementation> as ExecutorImplementation,
      () => assert.fail('no session call for an invalid Run'),
    );
    const invalid = fromBinary(
      RunRequestSchema,
      toBinary(
        RunRequestSchema,
        create(RunRequestSchema, runRequest({ ...thread, state: 'paused' })),
      ),
    );
    const error = await Promise.resolve()
      .then(() => implementation.run(invalid, directContext('run')))
      .then(
        () => assert.fail('expected Run to fail'),
        (failure: unknown) => failure,
      );
    assert.ok(isContractError(error), String(error));
    assert.equal(error.code, 'invalid_input');
  });

  test("75 (E8): the WatchCancel item aborts the implementation's call.signal with an AbortError while the handler's stays live: a record made after it reaches the session", async (t) => {
    const seen: Seen = {};
    const { client, state } = await serve(t, {
      run: async (input, call) => {
        seen.call = call;
        await abortedOf(call.signal);
        seen.reason = call.signal.reason;
        await input.session.record({ event: { type: 'after.cancel' } });

        return { text: 'recorded' };
      },
    });

    const running = client.run(runRequest());
    running.catch(() => undefined);
    await eventually(() => state.watches.length === 1, 'WatchCancel opened');
    cancelWatches(state);

    assert.equal((await running).text, 'recorded', 'the Run was not cancelled');
    assert.ok(seen.reason instanceof DOMException, String(seen.reason));
    assert.equal(seen.reason.name, 'AbortError');
    assert.deepEqual(recordShape(state.records[0] ?? []), [
      { head: { sessionId, format: undefined } },
      { event: { type: 'after.cancel' } },
    ]);
  });

  test('76 (E9): after the cancel, rejecting with call.signal.reason fails run_cancelled ("The run was cancelled."), rejecting ContractError unavailable fails run_cancelled too (C-E1), resolving answers {text}', async (t) => {
    let outcome: 'reason' | 'unavailable' | 'resolve' = 'reason';
    const { client, state } = await serve(t, {
      run: async (_input, call) => {
        await abortedOf(call.signal);
        if (outcome === 'reason') throw call.signal.reason;
        if (outcome === 'unavailable')
          throw new ContractError('unavailable', 'The session is gone.');

        return { text: 'resolved' };
      },
    });
    const cancelled = async () => {
      const watched = state.watches.length;
      const running = client.run(runRequest());
      running.catch(() => undefined);
      await eventually(
        () => state.watches.length === watched + 1,
        'WatchCancel opened',
      );
      cancelWatches(state);

      return running;
    };

    const rejected = await rejectionOfRun(cancelled());
    assert.equal(rejected.grpc, Code.FailedPrecondition);
    assert.equal(rejected.error.code, 'run_cancelled');
    assert.equal(rejected.error.message, 'The run was cancelled.');

    outcome = 'unavailable';
    // C-E1: any failure after the item, a ContractError included, is the cancel.
    const unavailable = await rejectionOfRun(cancelled());
    assert.equal(unavailable.grpc, Code.FailedPrecondition);
    assert.equal(unavailable.error.code, 'run_cancelled');
    assert.equal(unavailable.error.message, 'The run was cancelled.');

    outcome = 'resolve';
    assert.equal((await cancelled()).text, 'resolved');
  });

  test('77 (E10): a session without WatchCancel (UNIMPLEMENTED), or one that ends it with no item, lets the run complete; its call.signal never aborts', async (t) => {
    const signals: AbortSignal[] = [];
    const { client, state } = await serve(t, {
      run: async (_input, call) => {
        signals.push(call.signal);
        // Lets the failed or ended WatchCancel settle first.
        await new Promise((resolve) => setTimeout(resolve, 50));

        return { text: 'done' };
      },
    });

    for (const mode of ['unimplemented', 'end'] as const) {
      state.watchMode = mode;
      assert.equal((await client.run(runRequest())).text, 'done', mode);
    }

    assert.equal(state.watches.length, 2, 'each Run tried WatchCancel');
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [false, false],
    );
  });

  test('78 (E11): the WatchCancel call is cancelled once run settles', async (t) => {
    const { client, state } = await serve(t, {
      run: async () => ({ text: 'quick' }),
    });

    await client.run(runRequest());

    await eventually(
      () => state.watches[0]?.signal.aborted === true,
      'the WatchCancel handler signal aborted',
    );
  });

  test("85 (E15): Compact opens WatchCancel{sessionId} before any other session call (none for an invalid thread); the item aborts the implementation's call.signal (AbortError), not the handler's; a record after it reaches the session; WatchCancel is cancelled when compact settles", async (t) => {
    const seen: Seen = {};
    const { client, state } = await serve(t, {
      compact: async (input, call) => {
        await input.session.steers?.();
        seen.call = call;
        await abortedOf(call.signal);
        seen.reason = call.signal.reason;
        await input.session.record({
          event: { type: 'compaction.failed', code: 'summarizer_failed' },
        });

        return { status: 'failed', code: 'summarizer_failed' };
      },
    });

    const compacting = client.compact(compactRequest());
    compacting.catch(() => undefined);
    await eventually(() => state.watches.length === 1, 'WatchCancel opened');
    assert.deepEqual(
      state.watches.map(({ sessionId: id, after }) => ({ id, after })),
      [{ id: sessionId, after: 0 }],
    );
    await eventually(() => seen.call !== undefined, 'compact running');
    cancelWatches(state);

    assert.deepEqual(
      decode(CompactResponseSchema, await compacting, runtimeOneofs),
      { status: 'failed', code: 'summarizer_failed' },
      'the Compact call was not cancelled',
    );
    assert.ok(seen.reason instanceof DOMException, String(seen.reason));
    assert.equal(seen.reason.name, 'AbortError');
    assert.deepEqual(recordShape(state.records[0] ?? []), [
      { head: { sessionId, format: undefined } },
      { event: { type: 'compaction.failed', code: 'summarizer_failed' } },
    ]);

    const quick = await serve(t, {
      compact: async () => ({ status: 'refused', reason: 'disabled' }),
    });
    await quick.client.compact(compactRequest());
    await eventually(
      () => quick.state.watches[0]?.signal.aborted === true,
      'the WatchCancel cancelled once compact settled',
    );

    const implementation = serveExecutor(
      {
        compact: async () => ({ status: 'refused', reason: 'disabled' }),
      } as Partial<ExecutorImplementation> as ExecutorImplementation,
      () => assert.fail('no session call for an invalid Compact'),
    );
    const error = await Promise.resolve()
      .then(() =>
        implementation.compact(
          create(CompactRequestSchema, {
            ...compactRequest({ ...thread, state: 'paused' }),
          }),
          directContext('compact'),
        ),
      )
      .then(
        () => assert.fail('expected Compact to fail'),
        (failure: unknown) => failure,
      );
    assert.ok(isContractError(error), String(error));
    assert.equal(error.code, 'invalid_input');
  });

  test('86 (E16): after the item, compact rejecting with call.signal.reason fails compaction_cancelled ("The compaction was cancelled."), rejecting ContractError unavailable fails compaction_cancelled too (C-E1), resolving {status: failed, code: summarizer_failed} is answered encoded', async (t) => {
    let outcome: 'reason' | 'unavailable' | 'resolve' = 'reason';
    const { client, state } = await serve(t, {
      compact: async (_input, call) => {
        await abortedOf(call.signal);
        if (outcome === 'reason') throw call.signal.reason;
        if (outcome === 'unavailable')
          throw new ContractError('unavailable', 'The session is gone.');

        return { status: 'failed', code: 'summarizer_failed' };
      },
    });
    const cancelled = async () => {
      const watched = state.watches.length;
      const compacting = client.compact(compactRequest());
      compacting.catch(() => undefined);
      await eventually(
        () => state.watches.length === watched + 1,
        'WatchCancel opened',
      );
      cancelWatches(state);

      return compacting;
    };

    const rejected = await rejectionOfRun(cancelled());
    assert.equal(rejected.grpc, Code.FailedPrecondition);
    assert.equal(rejected.error.code, 'compaction_cancelled');
    assert.equal(rejected.error.message, 'The compaction was cancelled.');

    outcome = 'unavailable';
    // C-E1: any failure after the item, a ContractError included, is the cancel.
    const unavailable = await rejectionOfRun(cancelled());
    assert.equal(unavailable.grpc, Code.FailedPrecondition);
    assert.equal(unavailable.error.code, 'compaction_cancelled');
    assert.equal(unavailable.error.message, 'The compaction was cancelled.');

    outcome = 'resolve';
    assert.deepEqual(
      decode(CompactResponseSchema, await cancelled(), runtimeOneofs),
      { status: 'failed', code: 'summarizer_failed' },
    );
  });

  test('87 (E17): a session without WatchCancel (UNIMPLEMENTED) lets the compaction complete, its call.signal never aborts; Checkpoint and Rewind still open no WatchCancel', async (t) => {
    const signals: AbortSignal[] = [];
    const { client, state } = await serve(t, {
      compact: async (_input, call) => {
        signals.push(call.signal);
        await new Promise((resolve) => setTimeout(resolve, 50));

        return { status: 'refused', reason: 'nothing_to_compact' };
      },
      checkpoint: async () => ({ format, parts: {} }),
      rewind: async () => undefined,
    });
    state.watchMode = 'unimplemented';

    assert.deepEqual(
      decode(
        CompactResponseSchema,
        await client.compact(compactRequest()),
        runtimeOneofs,
      ),
      { status: 'refused', reason: 'nothing_to_compact' },
    );
    assert.equal(state.watches.length, 1, 'Compact tried WatchCancel');
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [false],
    );

    await drain(client.checkpoint({ sessionId, promptId }));
    await drain(client.rewind({ sessionId, promptId, removedPromptIds: [] }));
    assert.equal(state.watches.length, 1, 'none for Checkpoint and Rewind');
  });
});
