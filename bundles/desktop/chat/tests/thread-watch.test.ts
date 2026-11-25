// The Thread watch over `runtime.threads/v1`'s server stream `WatchThread`,
// with the cases of `app/desktop/doric/tests/thread-events.test.ts` ported to
// the stream (the socket's reconnect auth is the `afterSequence` of the next
// subscription) and the stream-only behaviour: invalid items, ended streams
// and the lost bridge. Slice S65a: the stream is the generated client's
// (`ThreadsService.WatchThread`, resumable) over a fake `HostClients`; the
// client SDK opens it again after `generation_lost`, so the watch does not,
// and the next item is the new opening's snapshot (spec
// `docs/designs/grpc-processes.md`, section 13, "The window from phase 3 to
// phase 5").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Client } from '@connectrpc/connect';
import {
  type ConnectionStatus,
  ContractError,
  toConnectError,
} from 'bundle/contracts';
import { encode, runtimeOneofs } from 'runtime/contracts';
import {
  ThreadsService,
  type WatchThreadRequest,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import {
  type ConnectionSource,
  createThreadWatch,
  invalidEventMessage,
  streamFailedMessage,
} from '../src/client/api/thread-watch.js';
import type { ThreadUpdate } from '../src/client/domain/workspace.js';
import { fakeHostClients, settle, streamOf, until } from './support/connect.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const PROMPT = '66666666-6666-4666-8666-666666666666';

/** Today's `watchThread` item as the proto message the host sends. */
const item = (value: unknown): WatchThreadResponse =>
  encode(WatchThreadResponseSchema, value, runtimeOneofs);

/** A `ConnectError` the host ends a stream with, read back as `code`. */
const ended = (code: string, message: string) =>
  toConnectError(new ContractError(code, message));

const fakeHost = () => {
  const streams = streamOf<WatchThreadRequest, WatchThreadResponse>();
  const host = fakeHostClients((router) => {
    router.service(ThreadsService, { watchThread: streams.serve });
  });
  const client: Client<typeof ThreadsService> = host.hostClients
    .part('chat')
    .use(ThreadsService);
  let status: ConnectionStatus = 'connected';
  const listeners = new Set<(status: ConnectionStatus) => void>();
  /** Timers the watch scheduled and that have not run or been cancelled. */
  const timers = new Set<() => void>();
  const connection: ConnectionSource = {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const watch = createThreadWatch({
    stream: () => client,
    connection: () => connection,
    schedule: (run) => {
      timers.add(run);
      return () => timers.delete(run);
    },
  });
  /** Runs every timer the watch has scheduled so far, as the delay elapsed. */
  const fireTimers = () => {
    const due = [...timers];
    timers.clear();
    for (const run of due) run();
  };
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  const subscriptions = streams.openings;
  const latest = () => streams.latest();
  return { watch, subscriptions, latest, setStatus, fireTimers, timers };
};

/** The opened request as today's input. */
const input = (request: WatchThreadRequest) => ({
  threadId: request.threadId,
  afterSequence: request.afterSequence,
});

const event = (sequence: number, threadId = THREAD) => ({
  projectId: PROJECT,
  threadId,
  promptId: PROMPT,
  sequence,
  type: 'agent.text',
  event: { text: `${sequence}` },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const thread = (id: string) => ({
  id,
  projectId: PROJECT,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const snapshot = (events: readonly unknown[], threadId = THREAD) =>
  item({
    kind: 'snapshot',
    threadId,
    projectId: PROJECT,
    project: null,
    thread: null,
    events,
  });

const eventItem = (sequence: number, threadId = THREAD) =>
  item({ kind: 'event', event: event(sequence, threadId) });

const recorder = () => {
  const updates: ThreadUpdate[] = [];
  return { updates, listener: (update: ThreadUpdate) => updates.push(update) };
};

const kinds = (updates: readonly ThreadUpdate[]) =>
  updates.map((update) =>
    update.kind === 'event' ? update.event.sequence : update.kind,
  );

describe('Thread watch over WatchThread', () => {
  test('forwards replay before live events without changing their order', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 2, seen.listener);
    await settle();

    assert.deepEqual(input(host.latest().request), {
      threadId: THREAD,
      afterSequence: 2,
    });
    host.latest().push(snapshot([event(3), event(4)]));
    host.latest().push(eventItem(5));
    await settle();

    assert.deepEqual(kinds(seen.updates), ['snapshot', 5]);
  });

  test('a snapshot reaches the listener with its events in today’s shape', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();

    host.latest().push(snapshot([event(1)]));
    await settle();

    const [update] = seen.updates;
    assert.ok(update !== undefined && update.kind === 'snapshot');
    assert.equal(update.snapshot.threadId, THREAD);
    assert.equal(update.snapshot.projectId, PROJECT);
    assert.deepEqual(update.snapshot.events, [event(1)]);
  });

  test('resubscribes after a lost bridge from the last delivered sequence, silently', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 7, seen.listener);
    await settle();
    host.latest().push(snapshot([event(8), event(9)]));
    host.latest().push(eventItem(10));
    await settle();

    host.setStatus('disconnected');
    host.latest().end(ended('disconnected', 'The bridge closed.'));
    await settle();
    assert.equal(host.subscriptions.length, 1);
    host.setStatus('connected');
    await settle();

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(input(host.latest().request), {
      threadId: THREAD,
      afterSequence: 10,
    });
    assert.deepEqual(kinds(seen.updates), ['snapshot', 10]);
  });

  test('resubscribes from the cursor after a delay when the bridge drops while the connection still reads connected', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().push(eventItem(3));
    await settle();

    host.latest().end(ended('disconnected', 'The bridge closed.'));
    await settle();
    assert.equal(host.subscriptions.length, 1);
    host.fireTimers();
    await settle();

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(input(host.latest().request), {
      threadId: THREAD,
      afterSequence: 3,
    });
    assert.deepEqual(kinds(seen.updates), [3]);
  });

  test('keeps resubscribing when the connection reports connected before the bridge is back', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().push(eventItem(4));
    await settle();

    // Sleep: the bridge drops, and the status monitor comes back first.
    host.setStatus('disconnected');
    host.latest().end(ended('disconnected', 'gone'));
    await settle();
    host.setStatus('connected');
    await settle();
    // That resubscription reaches a bridge that is still down.
    host.latest().end(ended('disconnected', 'gone'));
    await settle();
    host.fireTimers();
    await settle();
    host.latest().push(eventItem(5));
    await settle();

    assert.equal(host.subscriptions.length, 3);
    assert.equal(host.latest().request.afterSequence, 4);
    assert.deepEqual(kinds(seen.updates), [4, 5]);
  });

  test('treats an unavailable stream like a lost bridge, silently', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 2, seen.listener);
    await settle();

    host.latest().end(ended('unavailable', 'Doric is unavailable.'));
    await settle();
    host.fireTimers();
    await settle();

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(seen.updates, []);
  });

  test('T3.13 a stream ended with generation_lost is opened again by the client, and the next opening’s snapshot is shown', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().push(snapshot([event(6)]));
    host.latest().push(eventItem(7));
    await settle();

    host.latest().end(ended('generation_lost', 'Generation 1 exited.'));
    await until(() => host.subscriptions.length === 2, 'the reopened stream');
    assert.equal(host.latest().request.threadId, THREAD);
    host.latest().push(snapshot([event(6), event(7)]));
    host.latest().push(eventItem(8));
    await settle();

    assert.deepEqual(kinds(seen.updates), ['snapshot', 7, 'snapshot', 8]);
    host.fireTimers();
    host.setStatus('disconnected');
    host.setStatus('connected');
    await settle();
    assert.equal(
      host.subscriptions.length,
      2,
      'the watch itself does not reopen a stream the client reopened',
    );
  });

  test('a released watch cancels the resubscription it was waiting on', async () => {
    const host = fakeHost();
    const release = host.watch.watch(THREAD, 0, recorder().listener);
    await settle();
    host.latest().end(ended('disconnected', 'gone'));
    await settle();

    release();
    host.fireTimers();
    host.setStatus('disconnected');
    host.setStatus('connected');
    await settle();

    assert.equal(host.subscriptions.length, 1);
    assert.equal(host.timers.size, 0);
  });

  test("drops a foreign event carried inside this Thread's snapshot", async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().push(snapshot([event(3), event(9, OTHER), event(4)]));
    await settle();

    const [update] = seen.updates;
    assert.ok(update !== undefined && update.kind === 'snapshot');
    assert.deepEqual(
      update.snapshot.events.map((entry) => entry.sequence),
      [3, 4],
    );
    assert.equal(update.snapshot.threadId, THREAD);
    assert.equal(update.snapshot.projectId, PROJECT);

    // The foreign event must not move the cursor past this Thread's events.
    host.latest().end(ended('disconnected', 'gone'));
    await settle();
    host.setStatus('disconnected');
    host.setStatus('connected');
    await settle();
    assert.equal(host.latest().request.afterSequence, 4);
  });

  test('replaces a Thread watch, and the older one delivers nothing more', async () => {
    const host = fakeHost();
    const older = recorder();
    const newer = recorder();
    host.watch.watch(THREAD, 0, older.listener);
    await settle();
    const first = host.latest();
    host.watch.watch(THREAD, 4, newer.listener);
    await settle();
    const second = host.latest();

    second.push(eventItem(5));
    first.push(eventItem(6));
    await settle();

    assert.equal(first.closed, true);
    assert.equal(second.closed, false);
    assert.deepEqual(kinds(older.updates), []);
    assert.deepEqual(kinds(newer.updates), [5]);
  });

  test('watches two Threads at once, each on its own stream', async () => {
    const host = fakeHost();
    const first = recorder();
    const second = recorder();
    host.watch.watch(FIRST, 1, first.listener);
    await settle();
    const firstStream = host.latest();
    host.watch.watch(SECOND, 3, second.listener);
    await settle();
    const secondStream = host.latest();

    firstStream.push(eventItem(2, FIRST));
    secondStream.push(eventItem(4, SECOND));
    firstStream.push(item({ kind: 'updated', thread: thread(FIRST) }));
    secondStream.push(
      item({ kind: 'deleted', projectId: PROJECT, threadId: SECOND }),
    );
    await settle();

    assert.deepEqual(kinds(first.updates), [2, 'updated']);
    assert.deepEqual(second.updates.at(-1), {
      kind: 'deleted',
      projectId: PROJECT,
      threadId: SECOND,
    });
    assert.deepEqual(kinds(second.updates), [4, 'deleted']);
  });

  test('drops a snapshot, an event or a notice of another Thread', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    const stream = host.latest();

    stream.push(snapshot([event(1, OTHER)], OTHER));
    stream.push(eventItem(10, OTHER));
    stream.push(item({ kind: 'updated', thread: thread(OTHER) }));
    stream.push(item({ kind: 'deleted', projectId: PROJECT, threadId: OTHER }));
    await settle();

    assert.deepEqual(seen.updates, []);
  });

  test('releases only the Thread it is asked for, and releasing twice is harmless', async () => {
    const host = fakeHost();
    const first = recorder();
    const second = recorder();
    const stopFirst = host.watch.watch(FIRST, 0, first.listener);
    await settle();
    const firstStream = host.latest();
    host.watch.watch(SECOND, 0, second.listener);
    await settle();
    const secondStream = host.latest();

    stopFirst();
    stopFirst();
    firstStream.push(eventItem(1, FIRST));
    secondStream.push(eventItem(2, SECOND));
    await settle();

    assert.equal(firstStream.closed, true);
    assert.equal(secondStream.closed, false);
    assert.deepEqual(kinds(first.updates), []);
    assert.deepEqual(kinds(second.updates), [2]);
  });

  test('a released watch does not resubscribe when the connection returns', async () => {
    const host = fakeHost();
    const seen = recorder();
    const stop = host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().end(ended('disconnected', 'gone'));
    await settle();
    stop();
    host.setStatus('disconnected');
    host.setStatus('connected');
    await settle();

    assert.equal(host.subscriptions.length, 1);
  });

  test('an internal failure shows only the sanitized message', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host.latest().end(ended('internal', 'internal detail'));
    await settle();

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: THREAD, message: streamFailedMessage },
    ]);
  });

  test('a stream that fails reports its message once and is not resubscribed', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host
      .latest()
      .end(ended('replay_failed', 'The snapshot could not be loaded.'));
    await settle();
    host.setStatus('disconnected');
    host.setStatus('connected');
    await settle();

    assert.deepEqual(seen.updates, [
      {
        kind: 'error',
        threadId: THREAD,
        message: 'The snapshot could not be loaded.',
      },
    ]);
    assert.equal(host.subscriptions.length, 1);
  });

  test('reports an invalid event with the fixed message', async () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch(THREAD, 0, seen.listener);
    await settle();
    host
      .latest()
      .push(item({ kind: 'event', event: { ...event(1), sequence: -1 } }));
    await settle();

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: THREAD, message: invalidEventMessage },
    ]);
  });

  test('a stream the host cannot open reports the generic failure', async () => {
    const seen = recorder();
    const watch = createThreadWatch({
      stream: () => {
        throw new Error('no provider');
      },
      connection: () => undefined,
    });
    watch.watch(THREAD, 0, seen.listener);
    await settle();

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: THREAD, message: streamFailedMessage },
    ]);
  });
});
