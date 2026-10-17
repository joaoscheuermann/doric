import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  emptyTree,
  withSelection,
  withThreads,
} from '../src/client/domain/project-tree.js';
import { mainThreadFor } from '../src/client/domain/thread-navigation.js';
import type { Thread } from '../src/client/domain/workspace.js';
import { createThreadNavigation } from '../src/client/hooks/thread-navigation.js';
import { setLayoutServices } from '../src/client/services/layout-services.js';
import { createLayoutTabs } from '../src/client/services/layout-tabs.js';
import { setRouteWriter } from '../src/client/stores/route-selection.js';
import { workspaceStore } from '../src/client/stores/workspace.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';

beforeEach(() => {
  workspaceStore.setState({ tree: emptyTree });
  workspaceTabsStore.setState({ threads: {} });
});
afterEach(() => {
  setLayoutServices(undefined);
  setRouteWriter(undefined);
});

const thread = (
  id: string,
  parentThreadId?: string,
  projectId = 'project',
): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  cwd: '/workspace',
  lastSequence: 0,
  createdAt: '',
  updatedAt: '',
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
});

test('a child keeps the current main root in its Project', () => {
  const root = thread('root');
  const other = thread('other');
  const child = thread('child', 'other');
  const tree = withSelection(
    withThreads(emptyTree, 'project', [root, other, child]),
    {
      projectId: 'project',
      threadId: root.id,
    },
  );
  assert.equal(mainThreadFor(tree, child)?.id, 'root');
});

test('a fresh nested child opens beside its root ancestor', () => {
  const root = thread('root');
  const child = thread('child', 'root');
  const nested = thread('nested', 'child');
  const tree = withThreads(emptyTree, 'project', [root, child, nested]);
  assert.equal(mainThreadFor(tree, nested)?.id, 'root');
});

test('an existing child selection is replaced by its root before opening a child tab', () => {
  const root = thread('root');
  const child = thread('child', 'root');
  const tree = withSelection(withThreads(emptyTree, 'project', [root, child]), {
    projectId: 'project',
    threadId: child.id,
  });
  assert.equal(mainThreadFor(tree, child)?.id, 'root');
});

test('a root selection replaces the main conversation instead of opening a child tab', () => {
  const root = thread('root');
  assert.equal(mainThreadFor(emptyTree, root)?.id, root.id);
});

test('a child waits for its ancestor rather than becoming the main conversation', () => {
  const child = thread('child', 'root');
  assert.equal(mainThreadFor(emptyTree, child), undefined);
  assert.equal(
    mainThreadFor(
      withThreads(emptyTree, 'project', [thread('root'), child]),
      child,
    )?.id,
    'root',
  );
});

test('opening a Project skips child rows when choosing its first main thread', () => {
  const tree = withThreads(emptyTree, 'project', [
    thread('child', 'root'),
    thread('root'),
  ]);
  assert.equal(
    withSelection(tree, { projectId: 'project' }).selection.threadId,
    'root',
  );
});

test('opening a fetched child keeps the main conversation and exposes its record and reusable tab', async () => {
  const root = thread('root');
  const child = thread('child', root.id);
  workspaceStore.setState({
    tree: withSelection(withThreads(emptyTree, 'project', [root]), {
      projectId: root.projectId,
      threadId: root.id,
    }),
  });
  let path = '/projects/project/threads/child';
  setRouteWriter({
    path: () => path,
    navigate: (next) => {
      path = next;
    },
  });
  const harness = createTestServices({
    bundle: { id: 'probe' },
    provide: [
      createLayoutTabs({
        ui: {
          create: (tag, props) => ({ tag, props }),
          dispose: () => undefined,
        },
        owner: () => path.split('/').at(-1),
      }),
    ],
  });
  setLayoutServices(harness.services);
  const navigate = createThreadNavigation({
    intent: { current: 0 },
    loadThreads: async () => undefined,
    userSelection: () => undefined,
  });
  try {
    await navigate(child, false);
    assert.equal(workspaceStore.getState().tree.selection.threadId, root.id);
    assert.ok(
      workspaceStore
        .getState()
        .tree.threadsByProject.project.some((row) => row.id === child.id),
    );
    assert.equal(path, '/projects/project/threads/root');
    const tab = workspaceTabsStore.getState().threads.root.items[0];
    assert.equal(tab.kind, 'element');
    if (tab.kind !== 'element') return;
    assert.equal(tab.id, 'thread:child');
    assert.deepEqual(tab.element, {
      tag: 'chat-thread-panel',
      props: { projectId: 'project', threadId: 'child' },
    });
    await navigate(child, true);
    assert.equal(workspaceTabsStore.getState().threads.root.items.length, 1);
    assert.equal(workspaceTabsStore.getState().threads.root.items[0], tab);
  } finally {
    await harness.dispose();
  }
});

test('a fresh child visit loads ancestors before opening a tab owned by the root', async () => {
  const root = thread('root');
  const child = thread('child', root.id);
  const nested = thread('nested', child.id);
  let path = '/projects/project/threads/nested';
  setRouteWriter({
    path: () => path,
    navigate: (next) => {
      path = next;
    },
  });
  const harness = createTestServices({
    bundle: { id: 'probe' },
    provide: [
      createLayoutTabs({
        ui: {
          create: (tag, props) => ({ tag, props }),
          dispose: () => undefined,
        },
        owner: () => path.split('/').at(-1),
      }),
    ],
  });
  setLayoutServices(harness.services);
  try {
    const navigate = createThreadNavigation({
      intent: { current: 0 },
      loadThreads: async () => {
        workspaceStore
          .getState()
          .applyThreads('project', [root, child, nested]);
      },
      userSelection: () => undefined,
    });
    const selection = await navigate(nested, false);
    assert.deepEqual(selection, { projectId: 'project', threadId: root.id });
    assert.equal(path, '/projects/project/threads/root');
    assert.equal(
      workspaceTabsStore.getState().threads.root.selected,
      'thread:nested',
    );
    assert.equal(workspaceTabsStore.getState().threads.nested, undefined);
  } finally {
    await harness.dispose();
  }
});

test('leaving while child ancestors load does not open its tab or replace the newer conversation', async () => {
  const intent = { current: 0 };
  let release: () => void = () => undefined;
  const navigate = createThreadNavigation({
    intent,
    loadThreads: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    userSelection: () => undefined,
  });
  const pending = navigate(thread('child', 'root'), false);
  intent.current += 1;
  workspaceStore.getState().select({ projectId: 'other', threadId: 'newer' });
  release();
  assert.equal(await pending, undefined);
  assert.deepEqual(workspaceStore.getState().tree.selection, {
    projectId: 'other',
    threadId: 'newer',
  });
  assert.deepEqual(workspaceTabsStore.getState().threads, {});
});
