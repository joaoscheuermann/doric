// The Threads a window shows and the views it holds on them
// (docs/designs/thread-archive.md §6, §10.1, §10.8; T-23, T-24; AC4 on the
// window's side). From bundle isolation phase 3 the window holds each view
// through `view` of `runtime.records/v1` (T3.9); the view streams themselves
// are the runtime's.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Disposable, RouteMatch, Services } from 'bundle/contracts';
import type { RuntimeRecords } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

import {
  PROJECT_ROUTE,
  THREAD_ROUTE,
  WORKSPACE_ROUTE,
} from '../src/client/domain/route-selection.js';
import {
  THREAD_PANEL_TAG,
  THREAD_TAB_ICON,
} from '../src/client/domain/thread-navigation.js';
import { threadsOnScreen } from '../src/client/domain/thread-views.js';
import type {
  WorkspaceTab,
  WorkspaceTabs,
} from '../src/client/domain/workspace-tabs.js';
import { watchThreadViews } from '../src/client/services/thread-views.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';

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
  iconTag: THREAD_TAB_ICON,
});
const fileTab: WorkspaceTab = {
  id: 'file',
  kind: 'element',
  tag: 'files-file-view',
  title: 'README.md',
  element: {},
  props: { projectId, path: 'README.md' },
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

// T3.9: watchThreadViews -----------------------------------------------------

/** One `view` call or the disposal of the view it returned, in order. */
type ViewEvent = readonly ['take' | 'dispose', string];

/**
 * A records mirror whose `view` records each call and each disposal; every
 * other member is the in-memory fake's.
 */
const recordingRecords = () => {
  const events: ViewEvent[] = [];
  const records: RuntimeRecords = createRecordsApi();
  records.view = ({ threadId }): Disposable => {
    events.push(['take', threadId]);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        events.push(['dispose', threadId]);
      },
    };
  };
  /** The ids with a view held now, one entry per held view, sorted. */
  const held = (): readonly string[] => {
    const counts = new Map<string, number>();
    for (const [kind, threadId] of events) {
      counts.set(
        threadId,
        (counts.get(threadId) ?? 0) + (kind === 'take' ? 1 : -1),
      );
    }
    return [...counts]
      .flatMap(([threadId, count]) =>
        Array.from({ length: count }, () => threadId),
      )
      .sort();
  };
  return { records, events, held };
};

type WhenAvailableCallback = Parameters<Services['whenAvailable']>[1];

/**
 * The services `watchThreadViews` is bound to: `navigation/v1` answered from
 * `route`, and `runtime.records/v1` reached only through `whenAvailable`,
 * whose callback runs once the test makes the provider available. `use`
 * throws for every id but `navigation/v1`, as it does for a contract the
 * window has no provider of.
 */
const fakeServices = (records: RuntimeRecords) => {
  let route: RouteMatch | undefined;
  const routeListeners = new Set<(match: RouteMatch | undefined) => void>();
  const navigation = {
    current: () => route,
    subscribe: (
      listener: (match: RouteMatch | undefined) => void,
    ): Disposable => {
      routeListeners.add(listener);
      return { dispose: () => void routeListeners.delete(listener) };
    },
  };
  const waiting: ((api: RuntimeRecords) => void)[] = [];
  const used: string[] = [];
  const services = {
    provide: () => {
      throw new Error('watchThreadViews provides nothing.');
    },
    use: (contract: { readonly id: string }) => {
      used.push(contract.id);
      if (contract.id === 'navigation/v1') return navigation;
      throw new Error(`No provider of ${contract.id}.`);
    },
    whenAvailable: (
      contract: { readonly id: string },
      callback: WhenAvailableCallback,
    ): Disposable => {
      if (contract.id !== 'runtime.records/v1')
        return { dispose: () => undefined };
      let cleanup: ReturnType<WhenAvailableCallback>;
      let live = true;
      const start = (api: RuntimeRecords) => {
        if (live)
          cleanup = callback(api, { bundleId: 'runtime', version: '2.9.0' });
      };
      waiting.push(start);
      return {
        dispose: () => {
          if (!live) return;
          live = false;
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  } as unknown as Services;
  return {
    services,
    used,
    /** The runtime's client part provides `runtime.records/v1`. */
    provideRecords: () => {
      for (const start of waiting.splice(0)) start(records);
    },
    navigate: (next: RouteMatch | undefined) => {
      route = next;
      for (const listener of [...routeListeners]) listener(next);
    },
  };
};

describe('watchThreadViews (T3.9)', () => {
  beforeEach(() => {
    workspaceTabsStore.setState({ threads: {} });
  });
  afterEach(() => {
    workspaceTabsStore.setState({ threads: {} });
  });

  test('holds no view without a provider of runtime.records/v1, and takes them once one is available', () => {
    const { records, held } = recordingRecords();
    const host = fakeServices(records);
    host.navigate(threadRoute(routeThreadId));

    const stop = watchThreadViews(host.services);
    try {
      host.navigate(threadRoute(tabThreadId));
      assert.deepEqual(held(), []);
      assert.deepEqual(
        host.used.filter((id) => id !== 'navigation/v1'),
        [],
        'The watch reached a runtime contract outside whenAvailable.',
      );

      host.provideRecords();
      assert.deepEqual(held(), [tabThreadId]);
    } finally {
      stop();
    }
  });

  test('a Thread on screen before and after a change keeps its view: the new views are taken before the old ones are disposed', () => {
    const { records, events, held } = recordingRecords();
    const host = fakeServices(records);
    workspaceTabsStore.setState({
      threads: {
        [routeThreadId]: tabs([threadTab('t', tabThreadId)], 't'),
      },
    });
    host.navigate(threadRoute(routeThreadId));
    const stop = watchThreadViews(host.services);
    host.provideRecords();
    try {
      assert.deepEqual(held(), [routeThreadId, tabThreadId].sort());
      const before = events.length;

      host.navigate(threadRoute(tabThreadId));

      assert.deepEqual(held(), [tabThreadId]);
      let kept = 1;
      for (const [kind, threadId] of events.slice(before)) {
        if (threadId !== tabThreadId) continue;
        kept += kind === 'take' ? 1 : -1;
        assert.ok(kept > 0, 'The Thread still on screen lost its view.');
      }
    } finally {
      stop();
    }
  });

  test('its cleanup disposes every view, and a later change takes none', () => {
    const { records, held } = recordingRecords();
    const host = fakeServices(records);
    workspaceTabsStore.setState({
      threads: {
        [routeThreadId]: tabs([threadTab('t', tabThreadId)], 't'),
      },
    });
    host.navigate(threadRoute(routeThreadId));
    const stop = watchThreadViews(host.services);
    host.provideRecords();
    assert.deepEqual(held(), [routeThreadId, tabThreadId].sort());

    stop();
    assert.deepEqual(held(), []);

    host.navigate(threadRoute(tabThreadId));
    workspaceTabsStore.setState({ threads: {} });
    assert.deepEqual(held(), []);
    stop();
    assert.deepEqual(held(), []);
  });
});
