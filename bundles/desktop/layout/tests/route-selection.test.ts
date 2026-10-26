// The window path as the persisted selection (stage 9, §5.5): the startup
// restore, the legacy record, push versus replace, and what a navigation the
// layout did not make asks of the selection.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type { RouteMatch } from 'bundle/contracts';

import {
  emptyTree,
  type ProjectTree,
  withSelection,
  withThreads,
} from '../src/client/domain/project-tree.js';
import {
  pathFor,
  routeIntent,
  THREAD_ROUTE,
  threadPath,
} from '../src/client/domain/route-selection.js';
import { serializeSelection } from '../src/client/domain/selection.js';
import type { Thread } from '../src/client/domain/workspace.js';
import {
  type LegacySelection,
  resetRouteSelection,
  rewriteRoute,
  routeSelectionStore,
  setRouteWriter,
  startRestore,
} from '../src/client/stores/route-selection.js';

const thread = (id: string, projectId = 'p1'): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

const workspaceRoute: RouteMatch = { path: '/', pattern: '/', params: {} };

const projectsRoute: RouteMatch = {
  path: '/projects',
  pattern: '/projects',
  params: {},
};

const projectRoute: RouteMatch = {
  path: '/projects/p1',
  pattern: '/projects/:projectId',
  params: { projectId: 'p1' },
};

const threadRoute = (projectId: string, threadId: string): RouteMatch => ({
  path: threadPath(projectId, threadId),
  pattern: THREAD_ROUTE,
  params: { projectId, threadId },
});

/** A window history: the current path and every navigation written to it. */
class FakeWindow {
  current: string;
  readonly writes: { path: string; replace: boolean }[] = [];

  constructor(path: string) {
    this.current = path;
    setRouteWriter({
      path: () => this.current,
      navigate: (path, { replace }) => {
        this.writes.push({ path, replace });
        this.current = path;
      },
    });
  }
}

class FakeLegacy implements LegacySelection {
  constructor(public value: string | null) {}

  read(): string | null {
    return this.value;
  }

  remove(): void {
    this.value = null;
  }
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetRouteSelection();
  setRouteWriter(undefined);
});

const restore = (options: {
  readonly route: RouteMatch;
  readonly legacy?: FakeLegacy;
  readonly lookup: (id: string) => Promise<Thread | undefined>;
  readonly isCurrent?: () => boolean;
  readonly projectExists?: boolean;
}) => {
  const restored: Thread[] = [];
  const looked: string[] = [];
  startRestore({
    route: options.route,
    legacy: options.legacy ?? new FakeLegacy(null),
    lookup: (id) => {
      looked.push(id);
      return options.lookup(id);
    },
    isActive: () => true,
    isCurrent: options.isCurrent ?? (() => true),
    onRestore: (found) => {
      restored.push(found);
      return undefined;
    },
    onMissingProject: (projectId) =>
      options.projectExists === false ? {} : { projectId },
  });
  return { restored, looked };
};

describe('startup restore', () => {
  test('a failed asynchronous opener settles the restore without replacing its path', async () => {
    const window = new FakeWindow('/projects/p1/threads/child');
    startRestore({
      route: threadRoute('p1', 'child'),
      legacy: new FakeLegacy(null),
      lookup: async () => thread('child'),
      isActive: () => true,
      isCurrent: () => true,
      onRestore: async () => {
        throw new Error('Unavailable');
      },
      onMissingProject: (projectId) => ({ projectId }),
    });
    await settled();
    assert.equal(routeSelectionStore.getState().load, 'failed');
    assert.equal(window.current, '/projects/p1/threads/child');
  });

  test('a direct child link persists the root selected by its asynchronous opener', async () => {
    const window = new FakeWindow('/projects/p1/threads/child');
    startRestore({
      route: threadRoute('p1', 'child'),
      legacy: new FakeLegacy(null),
      lookup: async () => ({ ...thread('child'), parentThreadId: 'root' }),
      isActive: () => true,
      isCurrent: () => true,
      onRestore: async () => ({ projectId: 'p1', threadId: 'root' }),
      onMissingProject: (projectId) => ({ projectId }),
    });
    await settled();
    assert.deepEqual(window.writes, [
      { path: '/projects/p1/threads/root', replace: true },
    ]);
  });

  test('a superseded asynchronous child opener preserves the newer selection', async () => {
    const window = new FakeWindow('/projects/p1/threads/child');
    let release: () => void = () => undefined;
    startRestore({
      route: threadRoute('p1', 'child'),
      legacy: new FakeLegacy(null),
      lookup: async () => ({ ...thread('child'), parentThreadId: 'root' }),
      isActive: () => true,
      isCurrent: () => true,
      onRestore: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
      onMissingProject: (projectId) => ({ projectId }),
    });
    await settled();
    const store = routeSelectionStore.getState();
    store.markUserSelection({ projectId: 'p2', threadId: 'newer' });
    store.changeSelection({ projectId: 'p2', threadId: 'newer' });
    release();
    await settled();
    assert.equal(window.current, '/projects/p2/threads/newer');
  });

  test('a legacy stored Thread becomes its path once', async () => {
    const window = new FakeWindow('/');
    const legacy = new FakeLegacy(serializeSelection('t1'));

    const { restored } = restore({
      route: workspaceRoute,
      legacy,
      lookup: async (id) => thread(id),
    });
    await settled();

    assert.deepEqual(
      restored.map(({ id }) => id),
      ['t1'],
    );
    assert.equal(window.current, '/projects/p1/threads/t1');
    assert.equal(window.writes.at(-1)?.replace, true);
    assert.equal(legacy.value, null);
  });

  test("the route's Thread is restored and the legacy record is not consulted", async () => {
    const window = new FakeWindow('/projects/p1/threads/t2');
    const legacy = new FakeLegacy(serializeSelection('t1'));

    const { restored, looked } = restore({
      route: threadRoute('p1', 't2'),
      legacy,
      lookup: async (id) => thread(id),
    });
    await settled();

    assert.deepEqual(looked, ['t2']);
    assert.deepEqual(
      restored.map(({ id }) => id),
      ['t2'],
    );
    assert.equal(window.current, '/projects/p1/threads/t2');
    assert.equal(legacy.value, null);
  });

  test('a deleted Thread falls back to its existing Project', async () => {
    const window = new FakeWindow('/projects/p1/threads/gone');

    const { restored } = restore({
      route: threadRoute('p1', 'gone'),
      lookup: async () => undefined,
    });
    await settled();

    assert.deepEqual(restored, []);
    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });

  test('a deleted Thread and Project fall back to Home', async () => {
    const window = new FakeWindow('/projects/p1/threads/gone');

    restore({
      route: threadRoute('p1', 'gone'),
      lookup: async () => undefined,
      projectExists: false,
    });
    await settled();

    assert.deepEqual(window.writes, [{ path: '/', replace: true }]);
  });

  test('a failed lookup keeps the legacy record until a later change is written', async () => {
    const window = new FakeWindow('/');
    const legacy = new FakeLegacy(serializeSelection('t1'));

    const { restored } = restore({
      route: workspaceRoute,
      legacy,
      lookup: async () => {
        throw new Error('Doric backend is unavailable.');
      },
    });
    await settled();

    assert.deepEqual(restored, []);
    assert.equal(window.current, '/');
    assert.equal(routeSelectionStore.getState().load, 'failed');
    assert.equal(legacy.value, serializeSelection('t1'));

    routeSelectionStore
      .getState()
      .changeSelection({ projectId: 'p2', threadId: 't9' });

    assert.equal(window.current, '/projects/p2/threads/t9');
    assert.equal(legacy.value, null);
  });

  test('a user who acted during the lookup keeps their selection', async () => {
    const window = new FakeWindow('/projects/p1/threads/t1');
    let release: (value: Thread) => void = () => undefined;

    const { restored } = restore({
      route: threadRoute('p1', 't1'),
      lookup: () =>
        new Promise<Thread>((resolve) => {
          release = resolve;
        }),
      isCurrent: () => false,
    });
    const store = routeSelectionStore.getState();
    store.markUserSelection({ projectId: 'p2', threadId: 't9' });
    store.changeSelection({ projectId: 'p2', threadId: 't9' });
    assert.deepEqual(window.writes, [], 'nothing is written before the settle');

    release(thread('t1'));
    await settled();

    assert.deepEqual(restored, []);
    assert.equal(window.current, '/projects/p2/threads/t9');
  });

  test('nothing stored settles at once and writes nothing at /', () => {
    const window = new FakeWindow('/');

    const { looked } = restore({
      route: workspaceRoute,
      lookup: async (id) => thread(id),
    });

    assert.deepEqual(looked, []);
    assert.equal(routeSelectionStore.getState().load, 'none');
    assert.deepEqual(window.writes, []);
  });

  test("a window on another bundle's route keeps its path", () => {
    const window = new FakeWindow('/papercraft/checkout-preview');

    const { looked } = restore({
      route: {
        path: '/papercraft/checkout-preview',
        pattern: '/papercraft/:artifactId',
        params: { artifactId: 'checkout-preview' },
      },
      lookup: async (id) => thread(id),
    });

    assert.deepEqual(looked, []);
    assert.equal(routeSelectionStore.getState().load, 'none');
    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/papercraft/checkout-preview');
  });

  test('a path no route matches keeps its own URL', () => {
    const window = new FakeWindow('/nowhere');

    startRestore({
      route: undefined,
      legacy: new FakeLegacy(null),
      lookup: async (id) => thread(id),
      isActive: () => true,
      isCurrent: () => true,
      onRestore: () => undefined,
      onMissingProject: (projectId) => ({ projectId }),
    });

    assert.equal(routeSelectionStore.getState().load, 'none');
    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/nowhere');
  });

  test('a direct Project path is kept while the Project selection initializes', () => {
    const window = new FakeWindow('/projects/p1');

    restore({ route: projectRoute, lookup: async (id) => thread(id) });

    assert.deepEqual(window.writes, []);
  });

  test('a direct Project path becomes its first Thread when its list arrives', () => {
    const window = new FakeWindow('/projects/p1');
    restore({ route: projectRoute, lookup: async (id) => thread(id) });
    const store = routeSelectionStore.getState();
    const selected = withSelection(emptyTree, { projectId: 'p1' });
    store.changeSelection(selected.selection);
    const loaded = withThreads(selected, 'p1', [
      thread('first'),
      thread('second'),
    ]);
    store.changeSelection(loaded.selection);

    assert.deepEqual(window.writes, [
      {
        path: '/projects/p1/threads/first',
        replace: true,
      },
    ]);
    assert.deepEqual(routeIntent(threadRoute('p1', 'first'), loaded), {
      kind: 'none',
    });
  });

  test('a Thread chosen while the Project list loads keeps its route', () => {
    const window = new FakeWindow('/projects/p1');
    restore({ route: projectRoute, lookup: async (id) => thread(id) });
    const store = routeSelectionStore.getState();
    const selected = withSelection(emptyTree, {
      projectId: 'p1',
      threadId: 'second',
    });
    store.markUserSelection(selected.selection);
    store.changeSelection(selected.selection);
    store.changeSelection(
      withThreads(selected, 'p1', [thread('first'), thread('second')])
        .selection,
    );

    assert.deepEqual(window.writes, [
      {
        path: '/projects/p1/threads/second',
        replace: false,
      },
    ]);
  });

  test('an unreadable legacy record is nothing stored, and is removed', () => {
    new FakeWindow('/');
    const legacy = new FakeLegacy('{"selectedThreadId":"t1"}');

    const { looked } = restore({
      route: workspaceRoute,
      legacy,
      lookup: async (id) => thread(id),
    });

    assert.deepEqual(looked, []);
    assert.equal(legacy.value, null);
  });
});

describe('a view mounted after the restore settled', () => {
  const lookup = async (id: string) => thread(id);

  /** A window that restored at a Project without Threads, then went Home. */
  const homeFromProject = () => {
    const window = new FakeWindow('/projects/p1');
    restore({ route: projectRoute, lookup });
    routeSelectionStore.getState().changeSelection({ projectId: 'p1' });
    window.current = '/projects';
    window.writes.length = 0;
    return window;
  };

  test('Home from a Project without Threads keeps /projects', () => {
    const window = homeFromProject();

    restore({ route: projectsRoute, lookup });

    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/projects');
    assert.deepEqual(
      routeIntent(projectsRoute, withSelection(emptyTree, { projectId: 'p1' })),
      { kind: 'home' },
    );

    routeSelectionStore.getState().changeSelection({});

    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/projects');
  });

  test('Home from a selected Thread keeps /projects', async () => {
    const window = new FakeWindow('/projects/p1/threads/t1');
    restore({ route: threadRoute('p1', 't1'), lookup });
    await settled();
    window.current = '/projects';
    window.writes.length = 0;

    restore({ route: projectsRoute, lookup });
    routeSelectionStore.getState().changeSelection({});

    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/projects');
  });

  test('a Project opened after Home keeps its path', () => {
    const window = homeFromProject();
    restore({ route: projectsRoute, lookup });
    routeSelectionStore.getState().changeSelection({});
    window.current = '/projects/p2';
    window.writes.length = 0;

    restore({
      route: {
        path: '/projects/p2',
        pattern: '/projects/:projectId',
        params: { projectId: 'p2' },
      },
      lookup,
    });

    assert.deepEqual(window.writes, []);

    routeSelectionStore.getState().changeSelection({ projectId: 'p2' });

    assert.deepEqual(window.writes, []);
    assert.equal(window.current, '/projects/p2');
  });

  test('a Thread route mounted later is still restored', async () => {
    const window = new FakeWindow('/projects');
    restore({ route: projectsRoute, lookup });
    window.current = '/projects/p1/threads/t2';

    const { restored, looked } = restore({
      route: threadRoute('p1', 't2'),
      lookup,
    });
    await settled();

    assert.deepEqual(looked, ['t2']);
    assert.deepEqual(
      restored.map(({ id }) => id),
      ['t2'],
    );
    assert.equal(window.current, '/projects/p1/threads/t2');
  });
});

describe('selection writes', () => {
  /** A window whose restore settled with `selection` on screen at its path. */
  const settledWindow = (selection: {
    projectId?: string;
    threadId?: string;
  }) => {
    const window = new FakeWindow(pathFor(selection));
    routeSelectionStore.setState({ selection });
    routeSelectionStore.getState().settleLoad('none');
    window.writes.length = 0;
    return window;
  };

  test("a user's selection pushes its path", () => {
    const window = settledWindow({});
    const store = routeSelectionStore.getState();

    store.markUserSelection({ projectId: 'p1', threadId: 't1' });
    store.changeSelection({ projectId: 'p1', threadId: 't1' });

    assert.deepEqual(window.writes, [
      { path: '/projects/p1/threads/t1', replace: false },
    ]);
  });

  test('a selection the user did not make replaces the path', () => {
    const window = settledWindow({ projectId: 'p1', threadId: 't1' });
    const store = routeSelectionStore.getState();

    // The Thread was deleted: the selection keeps only its Project.
    store.changeSelection({ projectId: 'p1' });

    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });

  test('a stale user mark does not turn a later system change into a push', () => {
    const window = settledWindow({ projectId: 'p1', threadId: 't1' });
    const store = routeSelectionStore.getState();

    store.markUserSelection({ projectId: 'p1', threadId: 't1' });
    store.changeSelection({ projectId: 'p1', threadId: 't1' });
    store.changeSelection({ projectId: 'p1' });

    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });

  test('a Project-only selection keeps its own path', () => {
    assert.equal(pathFor({ projectId: 'p1' }), '/projects/p1');
    assert.equal(pathFor({}), '/');
  });

  test("a selection still writes over another bundle's route", () => {
    const window = new FakeWindow('/papercraft/checkout-preview');
    routeSelectionStore.setState({ selection: {} });
    routeSelectionStore.getState().settleLoad('none');
    window.writes.length = 0;

    routeSelectionStore.getState().changeSelection({ projectId: 'p1' });

    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });

  test('ids are encoded as path segments', () => {
    assert.equal(
      pathFor({ projectId: 'a/b', threadId: 'c d' }),
      '/projects/a%2Fb/threads/c%20d',
    );
  });

  test('a navigation that could not be selected is replaced by the selection path', () => {
    const window = settledWindow({});
    routeSelectionStore.getState().changeSelection({ projectId: 'p1' });
    window.writes.length = 0;
    window.current = '/projects/p1/threads/gone';

    rewriteRoute();

    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });

  test('a wrong Project segment for the selected Thread is replaced', () => {
    const window = settledWindow({ projectId: 'p1', threadId: 't1' });
    window.current = '/projects/p2/threads/t1';

    rewriteRoute();

    assert.deepEqual(window.writes, [
      { path: '/projects/p1/threads/t1', replace: true },
    ]);
  });

  test('history falls back to the Project of a removed Thread', () => {
    const window = settledWindow({});
    window.current = '/projects/p1/threads/gone';

    rewriteRoute({ projectId: 'p1' });

    assert.deepEqual(window.writes, [{ path: '/projects/p1', replace: true }]);
  });
});

describe('navigations the layout did not make', () => {
  const tree = (selection: ProjectTree['selection']): ProjectTree => ({
    projects: [],
    threadsByProject: { p1: [thread('t1'), thread('t2')] },
    selection,
  });

  test('a described Thread is selected', () => {
    const intent = routeIntent(
      threadRoute('p2', 't2'),
      tree({ projectId: 'p1', threadId: 't1' }),
    );

    assert.equal(intent.kind, 'select');
    assert.deepEqual(
      intent.kind === 'select'
        ? [intent.thread.id, intent.thread.projectId]
        : [],
      ['t2', 'p1'],
    );
  });

  test('a Thread the tree does not describe is restored', () => {
    assert.deepEqual(
      routeIntent(threadRoute('p9', 't9'), tree({ projectId: 'p1' })),
      { kind: 'restore', projectId: 'p9', threadId: 't9' },
    );
  });

  test('the selected Thread asks for nothing', () => {
    assert.deepEqual(
      routeIntent(
        threadRoute('p1', 't1'),
        tree({ projectId: 'p1', threadId: 't1' }),
      ),
      { kind: 'none' },
    );
  });

  test('a Thread path with a different Project asks for canonicalization', () => {
    assert.deepEqual(
      routeIntent(
        threadRoute('p2', 't1'),
        tree({ projectId: 'p1', threadId: 't1' }),
      ),
      { kind: 'canonical' },
    );
  });

  test('/ with a selected Thread returns Home', () => {
    assert.deepEqual(
      routeIntent(workspaceRoute, tree({ projectId: 'p1', threadId: 't1' })),
      { kind: 'home' },
    );
    assert.deepEqual(routeIntent(workspaceRoute, tree({ projectId: 'p1' })), {
      kind: 'home',
    });
  });
});
