// The window path as the persisted selection (stage 9, §5.5): the startup
// restore, the legacy record, push versus replace, and what a navigation the
// layout did not make asks of the selection.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type { RouteMatch } from 'bundle/contracts';

import type { ProjectTree } from '../src/client/domain/project-tree.js';
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
    onRestore: (found) => void restored.push(found),
  });
  return { restored, looked };
};

describe('startup restore', () => {
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

  test('a deleted Thread leaves the path at /', async () => {
    const window = new FakeWindow('/projects/p1/threads/gone');

    const { restored } = restore({
      route: threadRoute('p1', 'gone'),
      lookup: async () => undefined,
    });
    await settled();

    assert.deepEqual(restored, []);
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

    assert.deepEqual(window.writes, [{ path: '/', replace: true }]);
  });

  test('a stale user mark does not turn a later system change into a push', () => {
    const window = settledWindow({ projectId: 'p1', threadId: 't1' });
    const store = routeSelectionStore.getState();

    store.markUserSelection({ projectId: 'p1', threadId: 't1' });
    store.changeSelection({ projectId: 'p1', threadId: 't1' });
    store.changeSelection({ projectId: 'p1' });

    assert.deepEqual(window.writes, [{ path: '/', replace: true }]);
  });

  test('a Project-only selection is the path /', () => {
    assert.equal(pathFor({ projectId: 'p1' }), '/');
    assert.equal(pathFor({}), '/');
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
    window.current = '/projects/p1/threads/gone';

    rewriteRoute();

    assert.deepEqual(window.writes, [{ path: '/', replace: true }]);
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
      threadRoute('p1', 't2'),
      tree({ projectId: 'p1', threadId: 't1' }),
    );

    assert.equal(intent.kind, 'select');
    assert.equal(intent.kind === 'select' ? intent.thread.id : '', 't2');
  });

  test('a Thread the tree does not describe is restored', () => {
    assert.deepEqual(
      routeIntent(threadRoute('p9', 't9'), tree({ projectId: 'p1' })),
      { kind: 'restore', threadId: 't9' },
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

  test('/ with a selected Thread keeps only its Project', () => {
    assert.deepEqual(
      routeIntent(workspaceRoute, tree({ projectId: 'p1', threadId: 't1' })),
      { kind: 'project', projectId: 'p1' },
    );
    assert.deepEqual(routeIntent(workspaceRoute, tree({ projectId: 'p1' })), {
      kind: 'none',
    });
  });
});
