// The shared `comments.*` log of a Thread (`surface/thread-log.ts`): a stream
// lost with the bridge subscribes again from the last sequence it delivered,
// and the replay extends the events held; any other end leaves the log as it
// stands. Slice S65b: the log is `runtime.threads/v1`'s server stream
// `WatchThread` over the generated client (spec
// `docs/designs/grpc-processes.md`, section 13, "The window from phase 3 to
// phase 5"); `WatchThread` is resumable, so the SDK opens a stream that ended
// with `generation_lost` again, and the log keeps only what it had not held.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageShape } from '@bufbuild/protobuf';
import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  toConnectError,
} from 'bundle/contracts';
import { encode, runtimeOneofs } from 'runtime/contracts';
import {
  ThreadsService,
  type WatchThreadRequest,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import {
  resubscribeDelayMs,
  watchThreadComments,
} from '../../src/client/surface/thread-log.js';
import type { ThreadLogEvent } from '../../src/contracts/index.js';
import {
  fakeClientServices,
  fakeHostClients,
  settle,
  sleep,
  streamOf,
  until,
} from './support/connect.js';

type WatchItem = MessageShape<typeof WatchThreadResponseSchema>;

/** A `ConnectError` the host ends a stream with, read back as `code`. */
const ended = (code: string, message: string) =>
  toConnectError(new ContractError(code, message));

/** Today's watch item as the `WatchThreadResponse` the host sends (the host's codec). */
const item = (value: unknown): WatchItem =>
  encode(WatchThreadResponseSchema, value, runtimeOneofs);

const fakeWindow = () => {
  const watches = streamOf<WatchThreadRequest, WatchItem>();
  const host = fakeHostClients((router) => {
    router.service(ThreadsService, { watchThread: watches.serve });
  });
  let status: ConnectionStatus = 'connected';
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const { services } = fakeClientServices({
    bundleId: 'papercraft',
    hostClients: host.hostClients,
    connection: {
      status: () => status,
      subscribe: (listener): Disposable => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
    },
  });
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  /** The `afterSequence` of each opening, in order. */
  const from = () =>
    watches.openings.map(({ request }) => request.afterSequence);

  return { services, watches, host, from, setStatus };
};

const logEvent = (sequence: number, type: string): ThreadLogEvent => ({
  sequence,
  type,
  event: { sequence },
});

const sequences = (events: readonly ThreadLogEvent[] | undefined) =>
  events?.map((event) => event.sequence);

const scope = { projectId: 'p1', threadId: 't1' };

test('opens WatchThread over Connect, in the Thread scope, from sequence 0', async () => {
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);
  await settle();

  assert.equal(window.watches.openings.length, 1);
  const [opening] = window.watches.openings;
  assert.equal(opening?.request.threadId, 't1');
  assert.equal(opening?.request.afterSequence, 0);
  assert.deepEqual(opening?.scope, scope);
  release();
});

test('a generation_lost stream is opened again by the client, and its replay extends the log once', async () => {
  const window = fakeWindow();
  let heard: readonly ThreadLogEvent[] | undefined;
  const release = watchThreadComments(window.services, scope, (events) => {
    heard = events;
  });
  await settle();

  window.watches.latest().push(
    item({
      kind: 'snapshot',
      events: [logEvent(1, 'comments.added/v1'), logEvent(2, 'agent.text')],
    }),
  );
  window.watches
    .latest()
    .push(item({ kind: 'event', event: logEvent(3, 'agent.text') }));
  await settle();
  assert.deepEqual(sequences(heard), [1]);

  window.watches.latest().end(ended('generation_lost', 'Generation 1 exited.'));
  await until(() => window.watches.openings.length === 2, 'the reopened watch');

  // The reopening may replay from the start: what the log held is not heard twice.
  window.watches.latest().push(
    item({
      kind: 'snapshot',
      events: [
        logEvent(1, 'comments.added/v1'),
        logEvent(2, 'agent.text'),
        logEvent(3, 'agent.text'),
        logEvent(4, 'comments.added/v1'),
      ],
    }),
  );
  await settle();
  assert.deepEqual(sequences(heard), [1, 4]);

  await sleep(resubscribeDelayMs + 100);
  assert.equal(
    window.watches.openings.length,
    2,
    'the log does not open the watch a third time',
  );
  release();
});

test('resubscribes from the last delivered sequence when the connection reports connected after a lost bridge', async () => {
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);
  await settle();

  window.watches
    .latest()
    .push(
      item({ kind: 'snapshot', events: [logEvent(5, 'comments.added/v1')] }),
    );
  await settle();
  window.setStatus('disconnected');
  window.watches
    .latest()
    .end(ended('disconnected', 'The bridge disconnected.'));
  await settle();
  window.setStatus('connected');
  await settle();

  assert.deepEqual(window.from(), [0, 5]);
  release();
});

test('resubscribes after the delay when an unavailable stream ends while the connection reads connected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);
  await settle();

  window.watches
    .latest()
    .push(
      item({ kind: 'snapshot', events: [logEvent(2, 'comments.added/v1')] }),
    );
  await settle();
  window.watches.latest().end(ended('unavailable', 'The host drains.'));
  await settle();
  assert.deepEqual(window.from(), [0]);

  t.mock.timers.tick(resubscribeDelayMs);
  await settle();
  assert.deepEqual(window.from(), [0, 2]);
  release();
});

test('does not subscribe again after a stream that failed for another reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);
  await settle();

  window.watches.latest().end(ended('not_found', 'No such Thread.'));
  await settle();
  t.mock.timers.tick(resubscribeDelayMs);
  window.setStatus('connected');
  await settle();

  assert.equal(window.watches.openings.length, 1);
  release();
});

test('a released log does not subscribe again when the connection returns', async () => {
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);
  await settle();

  window.watches.latest().end(ended('generation_lost', 'Generation 1 exited.'));
  release();
  await sleep(300);
  window.setStatus('connected');
  await settle();

  assert.equal(window.watches.openings.length, 1);
});
