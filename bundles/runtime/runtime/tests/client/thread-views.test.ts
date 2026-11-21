// The views a window holds on the Threads it shows
// (docs/designs/thread-archive.md §6, §10.8): `createThreadViews`, moved from
// the layout with its assertions (`L/tests/thread-views.test.ts:241-333`),
// and `view` of `runtime.records/v1` over it (bundle isolation T3.9).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  type StreamListener,
  type StreamObserver,
} from 'bundle/contracts';

import { createThreadViews } from '../../src/client/api/thread-views.js';
import type {
  ThreadViewInput,
  ThreadViewItem,
} from '../../src/contracts/index.js';
import {
  countNotices,
  createHost,
  end,
  flush,
  mirrorOf,
  openOf,
  project,
  thread,
  uuid,
} from './support/hosts.js';

interface ViewStream {
  readonly threadId: string;
  readonly observer: StreamObserver<ThreadViewItem>;
  disposed: boolean;
}

/** `runtime.threads/v1.viewThread`: the boundary the window holds views on. */
class FakeRuntime {
  readonly streams: ViewStream[] = [];

  viewThread(
    input: ThreadViewInput,
    listener: StreamListener<ThreadViewItem>,
  ): Disposable {
    const observer =
      typeof listener === 'function' ? { next: listener } : listener;
    const stream: ViewStream = {
      threadId: input.threadId,
      observer,
      disposed: false,
    };
    this.streams.push(stream);
    return {
      dispose: () => {
        stream.disposed = true;
      },
    };
  }

  /** The ids with an open stream, one entry per open stream. */
  get open(): readonly string[] {
    return this.streams
      .filter((stream) => !stream.disposed)
      .map((stream) => stream.threadId)
      .sort();
  }

  /** The open stream of `threadId`. */
  openOf(threadId: string): ViewStream {
    const stream = this.streams.find(
      (candidate) => candidate.threadId === threadId && !candidate.disposed,
    );
    assert.ok(stream !== undefined, `no open stream for ${threadId}`);
    return stream;
  }

  /** The provider ends the open stream of `threadId`. */
  end(threadId: string, error?: ContractError): void {
    const stream = this.openOf(threadId);
    stream.disposed = true;
    stream.observer.end?.(error);
  }

  opened(threadId: string): number {
    return this.streams.filter((stream) => stream.threadId === threadId).length;
  }
}

class FakeConnection {
  current: ConnectionStatus = 'connected';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  status(): ConnectionStatus {
    return this.current;
  }

  subscribe(listener: (status: ConnectionStatus) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  report(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of [...this.listeners]) listener(status);
  }
}

const setup = () => {
  const runtime = new FakeRuntime();
  const connection = new FakeConnection();
  const timers: (() => void)[] = [];
  const views = createThreadViews({
    runtime,
    connection,
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const fireTimers = () => {
    for (const run of timers.splice(0)) run();
  };
  return { runtime, connection, views, fireTimers };
};

describe('createThreadViews (T-24)', () => {
  test('set opens one view per new id and ends the views of ids it no longer names', () => {
    const { runtime, views } = setup();

    views.set(new Set(['a', 'b']));
    assert.deepEqual(runtime.open, ['a', 'b']);

    views.set(new Set(['b', 'c']));
    assert.deepEqual(runtime.open, ['b', 'c']);
    assert.equal(runtime.opened('b'), 1, 'a kept id keeps its stream');
  });

  test('the view item changes nothing', () => {
    const { runtime, views } = setup();
    views.set(new Set(['a']));

    runtime.openOf('a').observer.next({ kind: 'viewing', threadId: 'a' });

    assert.deepEqual(runtime.open, ['a']);
    assert.equal(runtime.opened('a'), 1);
  });

  for (const code of [
    'unavailable',
    'disconnected',
    'generation_lost',
  ] as const) {
    test(`a silent ${code} end opens the view again once the connection reports connected`, () => {
      const { runtime, connection, views } = setup();
      views.set(new Set(['a']));

      connection.current = 'disconnected';
      runtime.end('a', new ContractError(code, 'gone for now'));
      assert.deepEqual(runtime.open, []);

      connection.report('connected');
      assert.deepEqual(runtime.open, ['a']);
    });
  }

  test('a silent end while the connection stays up opens the view again after the delay', () => {
    const { runtime, views, fireTimers } = setup();
    views.set(new Set(['a']));

    runtime.end('a', new ContractError('unavailable', 'the runtime drains'));
    assert.deepEqual(runtime.open, []);

    fireTimers();
    assert.deepEqual(runtime.open, ['a']);
  });

  test('a not_found end drops the id until the next set names it', () => {
    const { runtime, connection, views, fireTimers } = setup();
    views.set(new Set(['a']));

    runtime.end('a', new ContractError('not_found', 'no such Thread'));
    connection.report('disconnected');
    connection.report('connected');
    fireTimers();
    assert.deepEqual(runtime.open, []);

    views.set(new Set(['a']));
    assert.deepEqual(runtime.open, ['a']);
  });

  test('close ends every view, and a later set follows again', () => {
    const { runtime, connection, views, fireTimers } = setup();
    views.set(new Set(['a', 'b']));

    views.close();
    assert.deepEqual(runtime.open, []);
    connection.report('disconnected');
    connection.report('connected');
    fireTimers();
    assert.deepEqual(runtime.open, []);
    views.close();

    views.set(new Set(['a']));
    assert.deepEqual(runtime.open, ['a']);
  });

  test('a view that ends silently after close is not opened again', () => {
    const { runtime, views, fireTimers } = setup();
    views.set(new Set(['a']));
    const stream = runtime.openOf('a');

    views.close();
    stream.observer.end?.(new ContractError('unavailable', 'late end'));
    fireTimers();

    assert.deepEqual(runtime.open, []);
  });
});

// T3.9: view of runtime.records/v1 -------------------------------------------

describe('view (T3.9)', () => {
  const projectId = uuid(1);
  const threadId = uuid(11);
  const seeded = () =>
    createHost({
      projects: [project(projectId)],
      threads: [thread(threadId, projectId)],
    });
  const streamsOf = (host: ReturnType<typeof seeded>, id: string) =>
    openOf(host.views).filter(({ input }) => input.threadId === id);

  test('the first view of a Thread opens one viewThread stream and a second opens none', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);

    records.view({ threadId });
    assert.equal(host.views.length, 1);
    assert.deepEqual(host.views[0]?.input, { threadId });

    records.view({ threadId });
    assert.equal(host.views.length, 1);
    assert.equal(streamsOf(host, threadId).length, 1);
  });

  test('disposing one of two views keeps the stream, and disposing the last ends it', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    const first = records.view({ threadId });
    const second = records.view({ threadId });

    first.dispose();
    assert.equal(streamsOf(host, threadId).length, 1);

    second.dispose();
    assert.equal(streamsOf(host, threadId).length, 0);
    assert.equal(host.views.length, 1);
  });

  test('each Thread with a view held has its own stream', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    const other = uuid(12);

    records.view({ threadId });
    const second = records.view({ threadId: other });
    assert.equal(streamsOf(host, threadId).length, 1);
    assert.equal(streamsOf(host, other).length, 1);

    second.dispose();
    assert.equal(streamsOf(host, threadId).length, 1);
    assert.equal(streamsOf(host, other).length, 0);
  });

  test('a silent end opens the stream again', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    records.view({ threadId });
    const [stream] = host.views;
    assert.ok(stream !== undefined);

    end(stream, new ContractError('unavailable', 'the runtime drains'));
    assert.equal(streamsOf(host, threadId).length, 0);

    host.fireTimers();
    assert.equal(streamsOf(host, threadId).length, 1);
  });

  test('after a not_found end the next view opens the stream again', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    records.view({ threadId });
    const [stream] = host.views;
    assert.ok(stream !== undefined);

    end(stream, new ContractError('not_found', 'no such Thread'));
    host.connection.report('disconnected');
    host.connection.report('connected');
    host.fireTimers();
    assert.equal(streamsOf(host, threadId).length, 0);

    records.view({ threadId });
    assert.equal(streamsOf(host, threadId).length, 1);
  });

  test('after a not_found end the next disposal that leaves a view held opens the stream again', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    const first = records.view({ threadId });
    records.view({ threadId });
    const [stream] = host.views;
    assert.ok(stream !== undefined);

    end(stream, new ContractError('not_found', 'no such Thread'));
    assert.equal(streamsOf(host, threadId).length, 0);

    first.dispose();
    assert.equal(streamsOf(host, threadId).length, 1);
  });

  test('a view changes no read, calls no subscriber and starts no load', async (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    const notices = countNotices(t, records);

    const held = records.view({ threadId });
    const [stream] = host.views;
    assert.ok(stream !== undefined);
    stream.observer.next({ kind: 'viewing', threadId });
    end(stream, new ContractError('not_found', 'no such Thread'));
    held.dispose();
    await flush();

    assert.equal(notices.count(), 0);
    assert.deepEqual(host.calls, ['viewThread']);
    assert.equal(records.thread(threadId), undefined);
  });

  test('closing the mirror ends every view', (t) => {
    const host = seeded();
    const records = mirrorOf(t, host);
    records.view({ threadId });

    records.close();

    assert.equal(openOf(host.views).length, 0);
  });
});
