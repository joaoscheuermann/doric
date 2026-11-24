// The two workspace `Watch` streams through the router (phase 3, S60d,
// contract s60 D5, §2.9, §6 R-watch-thread, R-watch-project, Q4, Q6, D6):
// `ThreadsService.Watch` relays `runtime.threads/v1.WatchThread` item by item;
// `ProjectsService.Watch` merges `runtime/v2.WatchProject` with
// `terminal/v1.WatchProject` as today's `/projects` namespace does (both
// snapshots first, notices held, early terminal output dropped); a source
// reopened after a generation change (its second snapshot) ends the Watch
// with UNAVAILABLE (Q4); a request breaking a rule answers `invalid_input` with
// today's handshake refusal sentence (Q6). The items carry what today's
// Socket.IO namespaces emit, compared on the same reads. Also `keptBefore`, the
// page cut of D6.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  type DescMessage,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { encode } from 'runtime/contracts';
import type { Socket } from 'socket.io-client';

import { WatchResponseSchema as ProjectWatchResponseSchema } from '../src/contracts/gen/doric/api/projects/v1/projects_pb.js';
import { WatchResponseSchema as ThreadWatchResponseSchema } from '../src/contracts/gen/doric/api/threads/v1/threads_pb.js';
import { API_PAGE_MAX_BYTES, keptBefore } from '../src/host/process/watch.js';
import { serve as serveKernel } from './support/host.js';
import type { Harness } from './support/router.js';
import { routerFakes, type Streams } from './support/router-fakes.js';
import {
  activated,
  project,
  projectId,
  type Refusal,
  refusalOf,
  sleep,
  terminal,
  thread,
  threadEvent,
  threadId,
} from './support/router-fixtures.js';
import { source } from './support/router-streams.js';

const refused = (reason: string, message: string, code: Code): Refusal => ({
  reason,
  message,
  code,
});

const interrupted = refused(
  'unavailable',
  'The workspace stream was interrupted; open it again.',
  Code.Unavailable,
);
const replayFailed = refused(
  'replay_failed',
  'The snapshot could not be loaded.',
  Code.Internal,
);
const notActive = refused(
  'unavailable',
  'transport is not active.',
  Code.Unavailable,
);

/** The part with the workspace streams `streams` (and no other consumed fake), activated for one test. */
const watching = (t: TestContext, streams: Streams): Promise<Harness> =>
  activated(t, { fakes: (record) => routerFakes(record, {}, streams) });

/** Reads one item at a time from an API stream; `refusal()` reads until it fails. */
const reader = <T>(stream: AsyncIterable<T>) => {
  const iterator = stream[Symbol.asyncIterator]();

  return {
    /** The next item; fails the test when the stream ends or fails first. */
    next: async (): Promise<T> => {
      const result = await iterator.next();

      assert.equal(result.done, false, 'the stream ended');

      return result.value as T;
    },
    /** The refusal the stream ends with, after any items still to come (counted). */
    refusal: async (): Promise<Refusal & { readonly skipped: number }> => {
      let skipped = 0;
      const refusal = await refusalOf(
        (async () => {
          for (;;) {
            const result = await iterator.next();

            if (result.done) return;
            skipped += 1;
          }
        })(),
      );

      return { ...refusal, skipped };
    },
    /** Resolves `true` when the stream ends cleanly. */
    ended: async (): Promise<boolean> => (await iterator.next()).done === true,
  };
};

/** `item` as proto JSON, beside the proto JSON of `expected` encoded as `schema`. */
const assertItem = <D extends DescMessage>(
  schema: D,
  item: MessageShape<D>,
  expected: unknown,
  label?: string,
): void => {
  assert.deepEqual(
    toJson(schema, item),
    toJson(schema, encode(schema, expected)),
    label,
  );
};

const threadDeleted = { projectId, threadId };
const output = (data: string, offset: number) => ({
  projectId,
  threadId,
  terminalId: terminal.id,
  data,
  offset,
});
const runtimeSnapshot = { snapshot: { projectId, project, threads: [thread] } };
const terminalSnapshot = { snapshot: { projectId, terminals: [terminal] } };
const projectSnapshotItem = {
  projectSnapshot: {
    projectId,
    project,
    threads: [thread],
    terminals: [terminal],
  },
};
const terminalSnapshotItem = {
  terminalSnapshot: { projectId, terminals: [terminal] },
};

// R-watch-thread ---------------------------------------------------------------

void test('R-watch-thread: relays snapshot, event, updated and deleted as their Watch cases, with afterSequence passed', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId, afterSequence: 5 }));
  const snapshot = {
    threadId,
    projectId,
    project,
    thread,
    events: [threadEvent(6)],
  };

  runtime.push({ snapshot });
  runtime.push({ event: threadEvent(7) });
  runtime.push({ updated: { ...thread, name: 'Renamed' } });
  runtime.push({ deleted: threadDeleted });

  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    threadSnapshot: snapshot,
  });
  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    agentEvent: threadEvent(7),
  });
  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    threadUpdated: { ...thread, name: 'Renamed' },
  });
  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    threadDeleted,
  });
  assert.deepEqual(await runtime.opened, { threadId, afterSequence: 5 });
});

void test('R-watch-thread: a missing Thread is a snapshot without thread; the Watch ends when the source ends', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId }));

  runtime.push({ snapshot: { threadId, events: [] } });
  runtime.end();

  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    threadSnapshot: { threadId, events: [] },
  });
  assert.equal(await stream.ended(), true);
});

void test('R-watch-thread: a second snapshot (the source reopened) ends the Watch with UNAVAILABLE (Q4)', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId }));

  runtime.push({ snapshot: { threadId, events: [] } });
  runtime.push({ event: threadEvent(1) });
  runtime.push({ snapshot: { threadId, events: [threadEvent(1)] } });

  await stream.next();
  await stream.next();
  assert.deepEqual(await stream.refusal(), { ...interrupted, skipped: 0 });
});

void test('R-watch-thread: a source replay_failed ends the Watch with INTERNAL replay_failed', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId }));

  runtime.fail(
    new ContractError('replay_failed', 'The snapshot could not be loaded.'),
  );

  assert.deepEqual(await stream.refusal(), { ...replayFailed, skipped: 0 });
});

void test('R-watch-thread: an unexpected source failure after the snapshot ends the Watch with internal_error', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId }));

  runtime.push({ snapshot: { threadId, events: [] } });
  await stream.next();
  runtime.fail(new Error('secret provider credentials'));

  assert.deepEqual(await stream.refusal(), {
    ...refused(
      'internal_error',
      'The request could not be completed.',
      Code.Internal,
    ),
    skipped: 0,
  });
});

void test('R-watch-thread: a client cancel cancels the source', async (t) => {
  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const controller = new AbortController();
  const stream = reader(
    h.threads().watch({ threadId }, { signal: controller.signal }),
  );

  runtime.push({ snapshot: { threadId, events: [] } });
  await stream.next();
  controller.abort();

  await runtime.closed;
  assert.equal(runtime.openings(), 1);
});

// R-watch-project ----------------------------------------------------------------

/** A Project Watch over two driven sources. */
const projectWatch = async (t: TestContext, signal?: AbortSignal) => {
  const runtime = source();
  const terminals = source();
  const h = await watching(t, {
    runtimeWatchProject: runtime.fake,
    terminalWatchProject: terminals.fake,
  });
  const stream = reader(
    h.projects().watch({ projectId }, signal === undefined ? {} : { signal }),
  );

  return { h, runtime, terminals, stream };
};

void test('R-watch-project: both snapshots, runtime first, answer project_snapshot (with terminals) then terminal_snapshot', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  runtime.push(runtimeSnapshot);
  await sleep(20);
  terminals.push(terminalSnapshot);

  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    projectSnapshotItem,
  );
  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    terminalSnapshotItem,
  );
  assert.deepEqual(await runtime.opened, { projectId });
  assert.deepEqual(await terminals.opened, { projectId });
});

void test('R-watch-project: both snapshots, terminal first, answer the same two items in the same order', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  terminals.push(terminalSnapshot);
  await sleep(20);
  runtime.push(runtimeSnapshot);

  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    projectSnapshotItem,
  );
  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    terminalSnapshotItem,
  );
});

void test('R-watch-project: later items of both sources follow in arrival order', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  runtime.push(runtimeSnapshot);
  terminals.push(terminalSnapshot);
  await stream.next();
  await stream.next();

  runtime.push({ threadUpdated: thread });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    threadUpdated: thread,
  });
  terminals.push({ output: output('ls\n', 3) });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalOutput: output('ls\n', 3),
  });
  terminals.push({ updated: { ...terminal, state: 'exited' } });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalUpdated: { ...terminal, state: 'exited' },
  });
  runtime.push({ threadDeleted });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    threadDeleted,
  });
  terminals.push({
    removed: { projectId, threadId, terminalId: terminal.id },
  });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalRemoved: { projectId, threadId, terminalId: terminal.id },
  });
  runtime.push({ projectUpdated: { ...project, name: 'Renamed' } });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    projectUpdated: { ...project, name: 'Renamed' },
  });
  runtime.push({ projectDeleted: { projectId } });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    projectDeleted: { projectId },
  });
});

void test('R-watch-project: a notice that arrives before both snapshots is sent after them', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  runtime.push(runtimeSnapshot);
  runtime.push({ threadUpdated: { ...thread, name: 'Early' } });
  await sleep(50);
  terminals.push(terminalSnapshot);

  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    projectSnapshotItem,
  );
  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    terminalSnapshotItem,
  );
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    threadUpdated: { ...thread, name: 'Early' },
  });
});

void test('R-watch-project: terminal_output before both snapshots is dropped; terminal notices are held', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  terminals.push(terminalSnapshot);
  terminals.push({ output: output('lost', 4) });
  terminals.push({ updated: { ...terminal, state: 'exited' } });
  await sleep(50);
  runtime.push(runtimeSnapshot);

  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    projectSnapshotItem,
  );
  assertItem(
    ProjectWatchResponseSchema,
    await stream.next(),
    terminalSnapshotItem,
  );
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalUpdated: { ...terminal, state: 'exited' },
  });
  terminals.push({ output: output('kept', 8) });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalOutput: output('kept', 8),
  });
});

void test('R-watch-project: terminal/v1 failing before its snapshot ends the Watch with INTERNAL replay_failed', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  runtime.push(runtimeSnapshot);
  terminals.fail(new ContractError('internal', 'boom'));

  assert.deepEqual(await stream.refusal(), { ...replayFailed, skipped: 0 });
});

void test('R-watch-project: runtime/v2 ending before its snapshot ends the Watch with replay_failed', async (t) => {
  const { runtime, terminals, stream } = await projectWatch(t);

  terminals.push(terminalSnapshot);
  runtime.end();

  assert.deepEqual(await stream.refusal(), { ...replayFailed, skipped: 0 });
});

void test('R-watch-project: without terminal/v1 the Watch ends with replay_failed, as today', async (t) => {
  const runtime = source();
  const h = await watching(t, { runtimeWatchProject: runtime.fake });
  const stream = reader(h.projects().watch({ projectId }));

  runtime.push(runtimeSnapshot);

  assert.deepEqual(await stream.refusal(), { ...replayFailed, skipped: 0 });
});

void test('R-watch-project: a second snapshot on either source ends the Watch with UNAVAILABLE (Q4)', async (t) => {
  for (const reopened of ['runtime', 'terminal'] as const) {
    const { runtime, terminals, stream } = await projectWatch(t);

    runtime.push(runtimeSnapshot);
    terminals.push(terminalSnapshot);
    await stream.next();
    await stream.next();
    if (reopened === 'runtime') runtime.push(runtimeSnapshot);
    else terminals.push(terminalSnapshot);

    assert.deepEqual(
      await stream.refusal(),
      { ...interrupted, skipped: 0 },
      reopened,
    );
  }
});

void test('R-watch-project: a later failure of a source ends the Watch with that failure (D3)', async (t) => {
  for (const [error, expected] of [
    [
      new ContractError('unavailable', 'runtime is restarting.'),
      refused('unavailable', 'runtime is restarting.', Code.Unavailable),
    ],
    [
      new Error('secret provider credentials'),
      refused(
        'internal_error',
        'The request could not be completed.',
        Code.Internal,
      ),
    ],
  ] as const) {
    const { runtime, terminals, stream } = await projectWatch(t);

    runtime.push(runtimeSnapshot);
    terminals.push(terminalSnapshot);
    await stream.next();
    await stream.next();
    runtime.fail(error);

    assert.deepEqual(await stream.refusal(), { ...expected, skipped: 0 });
  }
});

void test('R-watch-project: a client cancel cancels both sources', async (t) => {
  const controller = new AbortController();
  const { runtime, terminals, stream } = await projectWatch(
    t,
    controller.signal,
  );

  runtime.push(runtimeSnapshot);
  terminals.push(terminalSnapshot);
  await stream.next();
  controller.abort();

  await Promise.all([runtime.closed, terminals.closed]);
});

void test('R0: deactivate ends an open Thread or Project Watch with unavailable', async (t) => {
  const runtime = source();
  const projects = source();
  const terminals = source();
  const h = await watching(t, {
    watchThread: runtime.fake,
    runtimeWatchProject: projects.fake,
    terminalWatchProject: terminals.fake,
  });
  const threadStream = reader(h.threads().watch({ threadId }));
  const projectStream = reader(h.projects().watch({ projectId }));

  runtime.push({ snapshot: { threadId, events: [] } });
  projects.push(runtimeSnapshot);
  terminals.push(terminalSnapshot);
  await threadStream.next();
  await projectStream.next();
  await projectStream.next();
  await h.host.deactivate();

  assert.deepEqual(await threadStream.refusal(), { ...notActive, skipped: 0 });
  assert.deepEqual(await projectStream.refusal(), {
    ...notActive,
    skipped: 0,
  });
});

// Q6: a Watch request breaking a rule -------------------------------------------------

void test("Q6: a Watch request breaking a rule answers invalid_input with today's handshake refusal sentence", async (t) => {
  const h = await watching(t, {});
  const invalid = (message: string) =>
    refused('invalid_input', message, Code.InvalidArgument);

  for (const [label, call, expected] of [
    [
      'project id',
      () => reader(h.projects().watch({ projectId: 'bad' })).next(),
      invalid('Invalid project subscription.'),
    ],
    [
      'thread id',
      () => reader(h.threads().watch({ threadId: 'bad' })).next(),
      invalid('Invalid thread subscription.'),
    ],
    [
      'negative afterSequence',
      () => reader(h.threads().watch({ threadId, afterSequence: -1 })).next(),
      invalid('Invalid thread subscription.'),
    ],
    [
      'fractional afterSequence',
      () => reader(h.threads().watch({ threadId, afterSequence: 1.5 })).next(),
      invalid('Invalid thread subscription.'),
    ],
  ] as const) {
    assert.deepEqual(await refusalOf(call()), expected, label);
  }
  assert.deepEqual(h.calls, []);
});

// Parity with today's Socket.IO namespaces -------------------------------------------

/** The next `name` event of `socket`. */
const next = <T = unknown>(socket: Socket, name: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, receive);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 2000);
    const receive = (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    };

    socket.once(name, receive);
  });

/** The kernel with the reads both namespaces snapshot, and the terminal feed a case drives. */
const kernel = async (t: TestContext) => {
  const terminalListeners: ((item: unknown) => void)[] = [];
  const host = await serveKernel({
    runtime: {
      project: () => project,
      watch: () => ({ dispose: () => undefined }),
    },
    threads: {
      storedThread: () => thread,
      storedEventsAfter: ({ afterSequence }: { afterSequence: number }) =>
        [threadEvent(1), threadEvent(2)].filter(
          ({ sequence }) => sequence > afterSequence,
        ),
      projectThreads: () => [thread],
    },
    terminal: {
      list: () => [terminal],
      watchProject: (_id: string, listener: unknown) => {
        terminalListeners.push((item) =>
          typeof listener === 'function'
            ? listener(item)
            : (listener as { next(item: unknown): void }).next(item),
        );

        return { dispose: () => undefined };
      },
    },
  });

  t.after(host.close);

  return {
    host,
    emit: (item: unknown) => {
      for (const listener of terminalListeners) listener(item);
    },
  };
};

void test("parity: the Thread Watch's thread_snapshot is today's /threads thread:snapshot payload", async (t) => {
  const { host } = await kernel(t);
  const socket = host.connect('/threads', { threadId, afterSequence: 1 });

  t.after(() => socket.close());
  const payload = await next(socket, 'thread:snapshot');

  const runtime = source();
  const h = await watching(t, { watchThread: runtime.fake });
  const stream = reader(h.threads().watch({ threadId, afterSequence: 1 }));

  // runtime.threads/v1.WatchThread serves today's algorithm over the same reads.
  runtime.push({ snapshot: payload as never });
  assertItem(ThreadWatchResponseSchema, await stream.next(), {
    threadSnapshot: payload,
  });
  assert.deepEqual(await runtime.opened, { threadId, afterSequence: 1 });
});

void test("parity: the Project Watch's first items are today's /projects project:snapshot and terminal:snapshot, then terminal:output", async (t) => {
  const { host, emit } = await kernel(t);
  const socket = host.connect('/projects', { projectId });

  t.after(() => socket.close());
  const projectPayload = next(socket, 'project:snapshot');
  const terminalPayload = next(socket, 'terminal:snapshot');
  const expectedProject = await projectPayload;
  const expectedTerminals = await terminalPayload;
  const outputPayload = next(socket, 'terminal:output');

  emit({ kind: 'output', output: output('kept', 8) });
  const expectedOutput = await outputPayload;

  const { runtime, terminals, stream } = await projectWatch(t);

  runtime.push(runtimeSnapshot);
  terminals.push(terminalSnapshot);
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    projectSnapshot: expectedProject,
  });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalSnapshot: expectedTerminals,
  });
  terminals.push({ output: output('kept', 8) });
  assertItem(ProjectWatchResponseSchema, await stream.next(), {
    terminalOutput: expectedOutput,
  });
});

void test("parity (Q6): the Watch refusal's sentence is today's handshake connect_error message", async (t) => {
  const { host } = await kernel(t);
  const h = await watching(t, {});

  for (const [namespace, auth, call] of [
    [
      '/projects',
      { projectId: 'bad' },
      () => reader(h.projects().watch({ projectId: 'bad' })).next(),
    ],
    [
      '/threads',
      { threadId, afterSequence: -1 },
      () => reader(h.threads().watch({ threadId, afterSequence: -1 })).next(),
    ],
  ] as const) {
    const socket = host.connect(namespace, auth);
    const error = await next<Error>(socket, 'connect_error');

    socket.close();
    const refusal = await refusalOf(call());

    assert.equal(refusal.message, error.message, namespace);
    assert.equal(refusal.reason, 'invalid_input', namespace);
  }
});

// keptBefore (D6) -----------------------------------------------------------------------

void test('D6: API_PAGE_MAX_BYTES is 3 MiB', () => {
  assert.equal(API_PAGE_MAX_BYTES, 3 * 1024 * 1024);
});

void test('D6: keptBefore keeps the longest prefix whose size is below max, at least one item', () => {
  const sizes = [40, 30, 20, 10, 5];
  const size = (kept: readonly number[]) =>
    kept.reduce((total, item) => total + item, 0);

  assert.equal(keptBefore([], size, 100), 0);
  assert.equal(keptBefore(sizes, size, 1000), sizes.length);
  assert.equal(keptBefore(sizes, size, 100), 3);
  assert.equal(keptBefore(sizes, size, 90), 2);
  assert.equal(keptBefore(sizes, size, 10), 1);
  assert.equal(keptBefore(sizes.slice(0, 4), size, 100), 3);
});

void test('D6: keptBefore uses API_PAGE_MAX_BYTES by default and calls size O(log n) times', () => {
  const items = Array.from({ length: 1024 }, () => 4096);
  let calls = 0;
  const size = (kept: readonly number[]) => {
    calls += 1;

    return kept.length * 4096;
  };

  // 768 items are exactly 3 MiB, which is not below it.
  assert.equal(keptBefore(items, size), 767);
  assert.ok(calls <= 2 * Math.log2(items.length) + 4, `${calls} calls`);
});
