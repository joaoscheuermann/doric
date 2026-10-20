// The Thread watch over `runtime.threads/v1.watchThread`, with the cases of
// `app/desktop/doric/tests/thread-events.test.ts` ported to the stream (the socket's
// reconnect auth is the `afterSequence` of the next subscription) and the
// stream-only behaviour: invalid items, ended streams and the lost bridge.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type StreamObserver,
} from 'bundle/contracts';

import {
  type ConnectionSource,
  createThreadWatch,
  invalidEventMessage,
  invalidSnapshotMessage,
  streamFailedMessage,
  type ThreadStreamItem,
} from '../src/client/api/thread-watch.js';
import type { ThreadUpdate } from '../src/client/domain/workspace.js';

interface Subscription {
  readonly input: { readonly threadId: string; readonly afterSequence: number };
  readonly observer: StreamObserver<ThreadStreamItem>;
  disposed: boolean;
}

const fakeHost = () => {
  const subscriptions: Subscription[] = [];
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
    stream: () => ({
      watchThread: (input, observer) => {
        const subscription: Subscription = {
          input,
          observer,
          disposed: false,
        };
        subscriptions.push(subscription);
        return {
          dispose: () => {
            subscription.disposed = true;
          },
        };
      },
    }),
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
  const latest = (): Subscription => {
    const last = subscriptions.at(-1);
    assert.ok(last !== undefined, 'no subscription was opened');
    return last;
  };
  return { watch, subscriptions, latest, setStatus, fireTimers, timers };
};

const event = (sequence: number, threadId = 'thread-id') => ({
  projectId: 'project-id',
  threadId,
  promptId: 'prompt-id',
  sequence,
  type: 'agent.text',
  event: { text: `${sequence}` },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const thread = (id: string) => ({
  id,
  projectId: 'project-id',
  name: id,
  state: 'ready',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const snapshot = (
  events: readonly unknown[],
  threadId = 'thread-id',
): ThreadStreamItem => ({
  kind: 'snapshot',
  threadId,
  projectId: 'project-id',
  project: null,
  thread: null,
  events,
});

const recorder = () => {
  const updates: ThreadUpdate[] = [];
  return { updates, listener: (update: ThreadUpdate) => updates.push(update) };
};

const kinds = (updates: readonly ThreadUpdate[]) =>
  updates.map((update) =>
    update.kind === 'event' ? update.event.sequence : update.kind,
  );

describe('Thread watch', () => {
  test('forwards replay before live events without changing their order', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 2, seen.listener);

    assert.deepEqual(host.latest().input, {
      threadId: 'thread-id',
      afterSequence: 2,
    });
    host.latest().observer.next(snapshot([event(3), event(4)]));
    host.latest().observer.next({ kind: 'event', event: event(5) });

    assert.deepEqual(kinds(seen.updates), ['snapshot', 5]);
  });

  test('resubscribes after a lost bridge from the last delivered sequence, silently', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 7, seen.listener);
    host.latest().observer.next(snapshot([event(8), event(9)]));
    host.latest().observer.next({ kind: 'event', event: event(10) });

    host.setStatus('disconnected');
    host
      .latest()
      .observer.end?.(new ContractError('disconnected', 'The bridge closed.'));
    assert.equal(host.subscriptions.length, 1);
    host.setStatus('connected');

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(host.latest().input, {
      threadId: 'thread-id',
      afterSequence: 10,
    });
    assert.deepEqual(kinds(seen.updates), ['snapshot', 10]);
  });

  test('resubscribes from the cursor after a delay when the bridge drops while the connection still reads connected', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host.latest().observer.next({ kind: 'event', event: event(3) });

    host
      .latest()
      .observer.end?.(new ContractError('disconnected', 'The bridge closed.'));
    assert.equal(host.subscriptions.length, 1);
    host.fireTimers();

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(host.latest().input, {
      threadId: 'thread-id',
      afterSequence: 3,
    });
    assert.deepEqual(kinds(seen.updates), [3]);
  });

  test('keeps resubscribing when the connection reports connected before the bridge is back', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host.latest().observer.next({ kind: 'event', event: event(4) });

    // Sleep: the bridge drops, and the status monitor comes back first.
    host.setStatus('disconnected');
    host.latest().observer.end?.(new ContractError('disconnected', 'gone'));
    host.setStatus('connected');
    // That resubscription reaches a bridge that is still down.
    host.latest().observer.end?.(new ContractError('disconnected', 'gone'));
    host.fireTimers();
    host.latest().observer.next({ kind: 'event', event: event(5) });

    assert.equal(host.subscriptions.length, 3);
    assert.equal(host.latest().input.afterSequence, 4);
    assert.deepEqual(kinds(seen.updates), [4, 5]);
  });

  test('treats an unavailable stream like a lost bridge, silently', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 2, seen.listener);

    host
      .latest()
      .observer.end?.(
        new ContractError('unavailable', 'Doric is unavailable.'),
      );
    host.fireTimers();

    assert.equal(host.subscriptions.length, 2);
    assert.deepEqual(seen.updates, []);
  });

  test('a released watch cancels the resubscription it was waiting on', () => {
    const host = fakeHost();
    const release = host.watch.watch('thread-id', 0, recorder().listener);
    host.latest().observer.end?.(new ContractError('disconnected', 'gone'));

    release();
    host.fireTimers();
    host.setStatus('disconnected');
    host.setStatus('connected');

    assert.equal(host.subscriptions.length, 1);
    assert.equal(host.timers.size, 0);
  });

  test("drops a foreign event carried inside this Thread's snapshot", () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host
      .latest()
      .observer.next(snapshot([event(3), event(9, 'other-thread'), event(4)]));

    const [update] = seen.updates;
    assert.ok(update !== undefined && update.kind === 'snapshot');
    assert.deepEqual(
      update.snapshot.events.map((entry) => entry.sequence),
      [3, 4],
    );
    assert.equal(update.snapshot.threadId, 'thread-id');
    assert.equal(update.snapshot.projectId, 'project-id');

    // The foreign event must not move the cursor past this Thread's events.
    host.latest().observer.end?.(new ContractError('disconnected', 'gone'));
    host.setStatus('disconnected');
    host.setStatus('connected');
    assert.equal(host.latest().input.afterSequence, 4);
  });

  test('replaces a Thread watch, and the older one delivers nothing more', () => {
    const host = fakeHost();
    const older = recorder();
    const newer = recorder();
    host.watch.watch('thread-id', 0, older.listener);
    const first = host.latest();
    host.watch.watch('thread-id', 4, newer.listener);
    const second = host.latest();

    second.observer.next({ kind: 'event', event: event(5) });
    first.observer.next({ kind: 'event', event: event(6) });

    assert.equal(first.disposed, true);
    assert.equal(second.disposed, false);
    assert.deepEqual(kinds(older.updates), []);
    assert.deepEqual(kinds(newer.updates), [5]);
  });

  test('watches two Threads at once, each on its own stream', () => {
    const host = fakeHost();
    const first = recorder();
    const second = recorder();
    host.watch.watch('first-thread', 1, first.listener);
    const firstStream = host.latest();
    host.watch.watch('second-thread', 3, second.listener);
    const secondStream = host.latest();

    firstStream.observer.next({
      kind: 'event',
      event: event(2, 'first-thread'),
    });
    secondStream.observer.next({
      kind: 'event',
      event: event(4, 'second-thread'),
    });
    firstStream.observer.next({
      kind: 'updated',
      thread: thread('first-thread'),
    });
    secondStream.observer.next({
      kind: 'deleted',
      projectId: 'project-id',
      threadId: 'second-thread',
    });

    assert.deepEqual(kinds(first.updates), [2, 'updated']);
    assert.deepEqual(second.updates.at(-1), {
      kind: 'deleted',
      projectId: 'project-id',
      threadId: 'second-thread',
    });
    assert.deepEqual(kinds(second.updates), [4, 'deleted']);
  });

  test('drops a snapshot, an event or a notice of another Thread', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    const { observer } = host.latest();

    observer.next(snapshot([event(1, 'other-thread')], 'other-thread'));
    observer.next({ kind: 'event', event: event(10, 'other-thread') });
    observer.next({ kind: 'updated', thread: thread('other-thread') });
    observer.next({
      kind: 'deleted',
      projectId: 'project-id',
      threadId: 'other-thread',
    });

    assert.deepEqual(seen.updates, []);
  });

  test('releases only the Thread it is asked for, and releasing twice is harmless', () => {
    const host = fakeHost();
    const first = recorder();
    const second = recorder();
    const stopFirst = host.watch.watch('first-thread', 0, first.listener);
    const firstStream = host.latest();
    host.watch.watch('second-thread', 0, second.listener);
    const secondStream = host.latest();

    stopFirst();
    stopFirst();
    firstStream.observer.next({
      kind: 'event',
      event: event(1, 'first-thread'),
    });
    secondStream.observer.next({
      kind: 'event',
      event: event(2, 'second-thread'),
    });

    assert.equal(firstStream.disposed, true);
    assert.equal(secondStream.disposed, false);
    assert.deepEqual(kinds(first.updates), []);
    assert.deepEqual(kinds(second.updates), [2]);
  });

  test('a released watch does not resubscribe when the connection returns', () => {
    const host = fakeHost();
    const seen = recorder();
    const stop = host.watch.watch('thread-id', 0, seen.listener);
    host.latest().observer.end?.(new ContractError('disconnected', 'gone'));
    stop();
    host.setStatus('disconnected');
    host.setStatus('connected');

    assert.equal(host.subscriptions.length, 1);
  });

  test('a failed stream shows only a sanitized message', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host.latest().observer.end?.(new Error('internal detail') as never);

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: 'thread-id', message: streamFailedMessage },
    ]);
  });

  test('a stream that fails reports its message once and is not resubscribed', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host
      .latest()
      .observer.end?.(
        new ContractError('replay_failed', 'The snapshot could not be loaded.'),
      );
    host.latest().observer.next({ kind: 'event', event: event(1) });
    host.setStatus('disconnected');
    host.setStatus('connected');

    assert.deepEqual(seen.updates, [
      {
        kind: 'error',
        threadId: 'thread-id',
        message: 'The snapshot could not be loaded.',
      },
    ]);
    assert.equal(host.subscriptions.length, 1);
  });

  test('reports an invalid snapshot and an invalid event with the fixed messages', () => {
    const host = fakeHost();
    const seen = recorder();
    host.watch.watch('thread-id', 0, seen.listener);
    host.latest().observer.next(snapshot('not events' as unknown as []));
    host
      .latest()
      .observer.next({ kind: 'event', event: { ...event(1), sequence: -1 } });

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: 'thread-id', message: invalidSnapshotMessage },
      { kind: 'error', threadId: 'thread-id', message: invalidEventMessage },
    ]);
  });

  test('a stream the host cannot open reports the generic failure', () => {
    const seen = recorder();
    const watch = createThreadWatch({
      stream: () => {
        throw new Error('no provider');
      },
      connection: () => undefined,
    });
    watch.watch('thread-id', 0, seen.listener);

    assert.deepEqual(seen.updates, [
      { kind: 'error', threadId: 'thread-id', message: streamFailedMessage },
    ]);
  });
});
