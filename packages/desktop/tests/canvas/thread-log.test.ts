// The shared log of a Thread (`desktop/ui/canvas`): one `watchThread` per
// Project and Thread in the window, whatever bundle subscribes; the comment
// listeners hear only `comments.*`, the revision listeners only their
// artifact's `artifacts.revised/v1`; a stream lost with the bridge or the host
// generation subscribes again from the last sequence it delivered, through the
// source of the most recent subscriber still there; any other end leaves the
// log as it stands.
//
// The log is module state keyed by Project and Thread: every test uses its own
// Thread and releases what it subscribed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type DoricConnection,
  type StreamListener,
  type StreamObserver,
} from 'bundle/contracts';
import {
  resubscribeDelayMs,
  type ThreadLogEvent,
  type ThreadWatchItem,
  type ThreadWatchSource,
  watchArtifactRevisions,
  watchThreadComments,
} from 'desktop/ui/canvas';

interface Call {
  readonly threadId: string;
  readonly afterSequence: number;
  readonly observer: StreamObserver<ThreadWatchItem>;
  disposed: boolean;
}

const observerOf = (
  listener: StreamListener<ThreadWatchItem>,
): StreamObserver<ThreadWatchItem> =>
  typeof listener === 'function' ? { next: listener } : listener;

/** A `watchThread` source that records each subscription it opens. */
const fakeSource = () => {
  const calls: Call[] = [];
  const source: ThreadWatchSource = {
    watchThread: (input, listener) => {
      const call: Call = {
        threadId: input.threadId,
        afterSequence: input.afterSequence,
        observer: observerOf(listener),
        disposed: false,
      };
      calls.push(call);
      return {
        dispose: () => {
          call.disposed = true;
        },
      };
    },
  };
  const latest = (): StreamObserver<ThreadWatchItem> => {
    const last = calls.at(-1);
    assert.ok(last !== undefined, 'no subscription was opened');
    return last.observer;
  };
  return { source, calls, latest };
};

/** `doric.connection/v1`, with a status the test moves. */
const fakeConnection = (initial: ConnectionStatus = 'connected') => {
  let status = initial;
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const connection: DoricConnection = {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  return { connection, setStatus };
};

let threads = 0;
/** A Thread no other test touches. */
const freshScope = () => ({
  projectId: 'p1',
  threadId: `thread-log-${++threads}`,
});

const logEvent = (
  sequence: number,
  type: string,
  event: unknown = { sequence },
): ThreadLogEvent => ({ sequence, type, event });

const revised = (sequence: number, artifactId: string, revision: number) =>
  logEvent(sequence, 'artifacts.revised/v1', { artifactId, revision });

const sequences = (events: readonly ThreadLogEvent[] | undefined) =>
  events?.map((event) => event.sequence);

/* Resubscription (moved from Papercraft) ----------------------------------- */

test('resubscribes from the last delivered sequence when the host generation is lost', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { source, calls, latest } = fakeSource();
  const { connection } = fakeConnection();
  let heard: readonly ThreadLogEvent[] | undefined;
  const release = watchThreadComments(
    source,
    connection,
    freshScope(),
    (events) => {
      heard = events;
    },
  );

  latest().next({
    kind: 'snapshot',
    events: [logEvent(1, 'comments.added/v1'), logEvent(2, 'agent.text')],
  });
  latest().next({ kind: 'event', event: logEvent(3, 'agent.text') });
  latest().end?.(new ContractError('generation_lost', 'Generation 1 exited.'));
  t.mock.timers.tick(resubscribeDelayMs);

  assert.deepEqual(
    calls.map((call) => call.afterSequence),
    [0, 3],
  );
  latest().next({
    kind: 'snapshot',
    events: [logEvent(4, 'comments.added/v1')],
  });
  assert.deepEqual(sequences(heard), [1, 4]);
  release();
});

test('resubscribes when the connection reports connected after a lost bridge', () => {
  const { source, calls, latest } = fakeSource();
  const { connection, setStatus } = fakeConnection();
  const release = watchThreadComments(
    source,
    connection,
    freshScope(),
    () => undefined,
  );

  latest().next({
    kind: 'snapshot',
    events: [logEvent(5, 'comments.added/v1')],
  });
  setStatus('disconnected');
  latest().end?.(new ContractError('disconnected', 'The bridge disconnected.'));
  setStatus('connected');

  assert.deepEqual(
    calls.map((call) => call.afterSequence),
    [0, 5],
  );
  release();
});

test('does not subscribe again after a stream that failed for another reason', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { source, calls, latest } = fakeSource();
  const { connection, setStatus } = fakeConnection();
  const release = watchThreadComments(
    source,
    connection,
    freshScope(),
    () => undefined,
  );

  latest().end?.(new ContractError('not_found', 'No such Thread.'));
  t.mock.timers.tick(resubscribeDelayMs);
  setStatus('connected');

  assert.equal(calls.length, 1);
  release();
});

test('a released log does not subscribe again when the connection returns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { source, calls, latest } = fakeSource();
  const { connection, setStatus } = fakeConnection();
  const release = watchThreadComments(
    source,
    connection,
    freshScope(),
    () => undefined,
  );

  latest().end?.(new ContractError('generation_lost', 'Generation 1 exited.'));
  release();
  t.mock.timers.tick(resubscribeDelayMs);
  setStatus('connected');

  assert.equal(calls.length, 1);
});

/* Sharing ------------------------------------------------------------------- */

test('two subscribers of one Thread share one watch, and both hear the replay', () => {
  const a = fakeSource();
  const b = fakeSource();
  const scope = freshScope();
  let heardA: readonly ThreadLogEvent[] | undefined;
  let heardB: readonly ThreadLogEvent[] | undefined;
  const releaseA = watchThreadComments(a.source, undefined, scope, (events) => {
    heardA = events;
  });
  const releaseB = watchThreadComments(b.source, undefined, scope, (events) => {
    heardB = events;
  });

  assert.equal(a.calls.length + b.calls.length, 1);
  const opened = (a.calls[0] ?? b.calls[0])?.observer;
  assert.ok(opened !== undefined);
  opened.next({
    kind: 'snapshot',
    events: [logEvent(1, 'comments.added/v1')],
  });

  assert.deepEqual(sequences(heardA), [1]);
  assert.deepEqual(sequences(heardB), [1]);
  releaseA();
  releaseB();
});

test('subscribers of different Threads open one watch each', () => {
  const { source, calls } = fakeSource();
  const first = freshScope();
  const second = freshScope();
  const releaseFirst = watchThreadComments(
    source,
    undefined,
    first,
    () => undefined,
  );
  const releaseSecond = watchThreadComments(
    source,
    undefined,
    second,
    () => undefined,
  );

  assert.deepEqual(
    calls.map((call) => call.threadId).sort(),
    [first.threadId, second.threadId].sort(),
  );
  releaseFirst();
  releaseSecond();
});

/* What each listener hears -------------------------------------------------- */

test('the comment listener hears only comments.*, never a live revision', () => {
  const { source, latest } = fakeSource();
  const heard: (readonly ThreadLogEvent[])[] = [];
  const release = watchThreadComments(
    source,
    undefined,
    freshScope(),
    (events) => {
      heard.push(events);
    },
  );

  latest().next({
    kind: 'snapshot',
    events: [
      logEvent(1, 'comments.added/v1'),
      revised(2, 'a1', 1),
      logEvent(3, 'agent.text'),
      logEvent(4, 'comments.resolved/v1'),
    ],
  });
  assert.deepEqual(sequences(heard.at(-1)), [1, 4]);
  const calls = heard.length;

  latest().next({ kind: 'event', event: revised(5, 'a1', 2) });
  assert.equal(heard.length, calls);

  latest().next({ kind: 'event', event: logEvent(6, 'comments.added/v1') });
  assert.deepEqual(sequences(heard.at(-1)), [1, 4, 6]);
  for (const events of heard)
    for (const event of events) assert.match(event.type, /^comments\./);
  release();
});

test('a revision listener hears its artifact’s revisions in order, repeats included', () => {
  const { source, latest } = fakeSource();
  const heard: number[] = [];
  const release = watchArtifactRevisions(
    source,
    undefined,
    freshScope(),
    'a1',
    (revision) => {
      heard.push(revision);
    },
  );

  latest().next({
    kind: 'snapshot',
    events: [revised(1, 'a1', 2), revised(2, 'a2', 3), revised(3, 'a1', 3)],
  });
  latest().next({ kind: 'event', event: revised(4, 'a1', 4) });
  latest().next({ kind: 'event', event: revised(5, 'a2', 5) });
  assert.deepEqual(heard, [2, 3, 4]);

  // The same revision again is delivered again: repeats are not filtered.
  latest().next({ kind: 'event', event: revised(6, 'a1', 4) });
  assert.deepEqual(heard, [2, 3, 4, 4]);
  release();
});

test('a revision listener that joins after the replay hears the held revisions at once', () => {
  const { source, latest } = fakeSource();
  const scope = freshScope();
  const releaseComments = watchThreadComments(
    source,
    undefined,
    scope,
    () => undefined,
  );
  latest().next({
    kind: 'snapshot',
    events: [revised(1, 'a1', 1), revised(2, 'a1', 2)],
  });

  const heard: number[] = [];
  const releaseRevisions = watchArtifactRevisions(
    source,
    undefined,
    scope,
    'a1',
    (revision) => {
      heard.push(revision);
    },
  );

  assert.deepEqual(heard, [1, 2]);
  releaseRevisions();
  releaseComments();
});

/* Resubscribe source and release ------------------------------------------- */

test('a lost stream subscribes again through the source of a subscriber still there', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakeSource();
  const b = fakeSource();
  const { connection } = fakeConnection();
  const scope = freshScope();
  const releaseA = watchThreadComments(
    a.source,
    connection,
    scope,
    () => undefined,
  );
  const releaseB = watchThreadComments(
    b.source,
    connection,
    scope,
    () => undefined,
  );
  const opened = a.latest();
  opened.next({
    kind: 'snapshot',
    events: [logEvent(7, 'comments.added/v1')],
  });

  releaseA();
  opened.end?.(new ContractError('generation_lost', 'Generation 1 exited.'));
  t.mock.timers.tick(resubscribeDelayMs);

  assert.equal(a.calls.length, 1);
  assert.deepEqual(
    b.calls.map((call) => call.afterSequence),
    [7],
  );
  releaseB();
});

test('the last release closes the watch, and a later subscriber opens one from 0', () => {
  const { source, calls, latest } = fakeSource();
  const scope = freshScope();
  const release = watchThreadComments(
    source,
    undefined,
    scope,
    () => undefined,
  );
  latest().next({
    kind: 'snapshot',
    events: [logEvent(3, 'comments.added/v1')],
  });

  release();
  assert.equal(calls[0]?.disposed, true);

  const again = watchThreadComments(source, undefined, scope, () => undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.afterSequence, 0);
  again();
  // Releasing twice is harmless.
  again();
});

test('a source whose watch throws leaves the listener silent', () => {
  const source: ThreadWatchSource = {
    watchThread: () => {
      throw new ContractError('not_found', 'No runtime.threads/v1 here.');
    },
  };
  let heard = 0;
  const scope = freshScope();
  const listen = () => {
    heard += 1;
  };

  const releaseComments = watchThreadComments(source, undefined, scope, listen);
  const releaseRevisions = watchArtifactRevisions(
    source,
    undefined,
    scope,
    'a1',
    listen,
  );
  releaseRevisions();
  releaseComments();

  assert.equal(heard, 0);
});
