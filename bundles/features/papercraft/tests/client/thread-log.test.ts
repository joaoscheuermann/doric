// The shared `comments.*` log of a Thread (`surface/thread-log.ts`): a stream
// lost with the bridge or with the host generation serving it subscribes
// again from the last sequence it delivered, and the replay extends the
// events held; any other end leaves the log as it stands.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type Services,
  type StreamObserver,
} from 'bundle/contracts';

import {
  resubscribeDelayMs,
  watchThreadComments,
} from '../../src/client/surface/thread-log.js';
import type {
  ThreadLogEvent,
  ThreadWatchItem,
} from '../../src/contracts/index.js';

interface Subscription {
  readonly afterSequence: number;
  readonly observer: StreamObserver<ThreadWatchItem>;
}

const fakeWindow = () => {
  const subscriptions: Subscription[] = [];
  let status: ConnectionStatus = 'connected';
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const services = {
    use: (contract: { readonly id: string }) => {
      if (contract.id === 'runtime.threads/v1')
        return {
          watchThread: (
            input: { readonly afterSequence: number },
            observer: StreamObserver<ThreadWatchItem>,
          ) => {
            subscriptions.push({
              afterSequence: input.afterSequence,
              observer,
            });
            return { dispose: () => undefined };
          },
        };
      if (contract.id === 'doric.connection/v1')
        return {
          status: () => status,
          subscribe: (listener: (status: ConnectionStatus) => void) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
          },
        };
      throw new Error(`unexpected ${contract.id}`);
    },
  } as unknown as Services;
  const latest = (): StreamObserver<ThreadWatchItem> => {
    const last = subscriptions.at(-1);
    assert.ok(last !== undefined, 'no subscription was opened');
    return last.observer;
  };
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  return { services, subscriptions, latest, setStatus };
};

const logEvent = (sequence: number, type: string): ThreadLogEvent => ({
  sequence,
  type,
  event: { sequence },
});

const sequences = (events: readonly ThreadLogEvent[] | undefined) =>
  events?.map((event) => event.sequence);

const scope = { projectId: 'p1', threadId: 't1' };

test('resubscribes from the last delivered sequence when the host generation is lost', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  let heard: readonly ThreadLogEvent[] | undefined;
  const release = watchThreadComments(window.services, scope, (events) => {
    heard = events;
  });

  window.latest().next({
    kind: 'snapshot',
    events: [logEvent(1, 'comments.added/v1'), logEvent(2, 'agent.text')],
  });
  window.latest().next({ kind: 'event', event: logEvent(3, 'agent.text') });
  window
    .latest()
    .end?.(new ContractError('generation_lost', 'Generation 1 exited.'));
  t.mock.timers.tick(resubscribeDelayMs);

  assert.deepEqual(
    window.subscriptions.map((subscription) => subscription.afterSequence),
    [0, 3],
  );
  window.latest().next({
    kind: 'snapshot',
    events: [logEvent(4, 'comments.added/v1')],
  });
  assert.deepEqual(sequences(heard), [1, 4]);
  release();
});

test('resubscribes when the connection reports connected after a lost bridge', () => {
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);

  window.latest().next({
    kind: 'snapshot',
    events: [logEvent(5, 'comments.added/v1')],
  });
  window.setStatus('disconnected');
  window
    .latest()
    .end?.(new ContractError('disconnected', 'The bridge disconnected.'));
  window.setStatus('connected');

  assert.deepEqual(
    window.subscriptions.map((subscription) => subscription.afterSequence),
    [0, 5],
  );
  release();
});

test('does not subscribe again after a stream that failed for another reason', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);

  window.latest().end?.(new ContractError('not_found', 'No such Thread.'));
  t.mock.timers.tick(resubscribeDelayMs);
  window.setStatus('connected');

  assert.equal(window.subscriptions.length, 1);
  release();
});

test('a released log does not subscribe again when the connection returns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const release = watchThreadComments(window.services, scope, () => undefined);

  window
    .latest()
    .end?.(new ContractError('generation_lost', 'Generation 1 exited.'));
  release();
  t.mock.timers.tick(resubscribeDelayMs);
  window.setStatus('connected');

  assert.equal(window.subscriptions.length, 1);
});
