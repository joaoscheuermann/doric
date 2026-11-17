// The Threads a window shows and the views it holds on them
// (docs/designs/thread-archive.md §6, §10.1, §10.8; T-23, T-24; AC4 on the
// window's side).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ConnectionStatus,
  ContractError,
  type Disposable,
  type RouteMatch,
  type StreamListener,
  type StreamObserver,
} from 'bundle/contracts';
import type { ThreadViewInput, ThreadViewItem } from 'runtime/contracts';

import { createThreadViews } from '../src/client/api/thread-views.js';
import {
  PROJECT_ROUTE,
  THREAD_ROUTE,
  WORKSPACE_ROUTE,
} from '../src/client/domain/route-selection.js';
import { threadsOnScreen } from '../src/client/domain/thread-views.js';
import {
  THREAD_PANEL_TAG,
  type WorkspaceTab,
  type WorkspaceTabs,
} from '../src/client/domain/workspace-tabs.js';

const projectId = '22222222-2222-4222-8222-222222222222';
const routeThreadId = '11111111-1111-4111-8111-111111111111';
const tabThreadId = '33333333-3333-4333-8333-333333333333';

const threadRoute = (threadId: string): RouteMatch => ({
  path: `/projects/${projectId}/threads/${threadId}`,
  pattern: THREAD_ROUTE,
  params: { projectId, threadId },
});
const projectRoute: RouteMatch = {
  path: `/projects/${projectId}`,
  pattern: PROJECT_ROUTE,
  params: { projectId },
};
const dashboardRoute: RouteMatch = {
  path: '/',
  pattern: WORKSPACE_ROUTE,
  params: {},
};

const threadTab = (id: string, threadId: string): WorkspaceTab => ({
  id,
  kind: 'element',
  tag: THREAD_PANEL_TAG,
  title: 'Thread',
  element: {},
  props: { threadId },
  icon: 'thread',
});
const fileTab: WorkspaceTab = {
  id: 'file',
  kind: 'file',
  path: 'README.md',
  projectId,
};
const otherElementTab: WorkspaceTab = {
  id: 'other',
  kind: 'element',
  tag: 'papercraft-preview',
  title: 'Preview',
  element: {},
  props: { threadId: tabThreadId },
};

const tabs = (
  items: readonly WorkspaceTab[],
  selected: string,
): WorkspaceTabs => ({ items, selected });

const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

describe('threadsOnScreen (T-23)', () => {
  test("the Thread route shows the route's Thread", () => {
    assert.deepEqual(
      sorted(threadsOnScreen(threadRoute(routeThreadId), projectId, {})),
      [routeThreadId],
    );
  });

  test('the Thread route adds the Thread of its selected Thread tab', () => {
    const shown = threadsOnScreen(threadRoute(routeThreadId), projectId, {
      [routeThreadId]: tabs([fileTab, threadTab('t', tabThreadId)], 't'),
    });

    assert.deepEqual(sorted(shown), [routeThreadId, tabThreadId].sort());
  });

  test('a selected file tab adds nothing', () => {
    const shown = threadsOnScreen(threadRoute(routeThreadId), projectId, {
      [routeThreadId]: tabs([fileTab, threadTab('t', tabThreadId)], 'file'),
    });

    assert.deepEqual(sorted(shown), [routeThreadId]);
  });

  test('a selected element tab that is not a Thread tab adds nothing', () => {
    const shown = threadsOnScreen(threadRoute(routeThreadId), projectId, {
      [routeThreadId]: tabs([otherElementTab], 'other'),
    });

    assert.deepEqual(sorted(shown), [routeThreadId]);
  });

  test('a Thread tab of the route Thread itself counts once', () => {
    const shown = threadsOnScreen(threadRoute(routeThreadId), projectId, {
      [routeThreadId]: tabs([threadTab('t', routeThreadId)], 't'),
    });

    assert.deepEqual(sorted(shown), [routeThreadId]);
  });

  test("the Project route shows the selected Project's selected Thread tab", () => {
    const shown = threadsOnScreen(projectRoute, projectId, {
      [`project:${projectId}`]: tabs([threadTab('t', tabThreadId)], 't'),
    });

    assert.deepEqual(sorted(shown), [tabThreadId]);
  });

  test('the dashboard route shows nothing', () => {
    const shown = threadsOnScreen(dashboardRoute, projectId, {
      [`project:${projectId}`]: tabs([threadTab('t', tabThreadId)], 't'),
    });

    assert.deepEqual(sorted(shown), []);
  });

  test('no route shows nothing', () => {
    assert.deepEqual(sorted(threadsOnScreen(undefined, undefined, {})), []);
  });
});

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
