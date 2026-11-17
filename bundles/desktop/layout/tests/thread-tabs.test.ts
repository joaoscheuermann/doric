import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyTree, withThreads } from '../src/client/domain/project-tree.js';
import type { Thread } from '../src/client/domain/workspace.js';
import {
  isThreadPanelTab,
  reconcileThreadTabs,
  type WorkspaceTab,
  type WorkspaceTabs,
} from '../src/client/domain/workspace-tabs.js';
import { watchThreadTabs } from '../src/client/services/thread-tabs.js';
import { workspaceStore } from '../src/client/stores/workspace.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';

const thread = (name: string): Thread => ({
  id: 'child',
  projectId: 'project',
  parentThreadId: 'parent',
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});
const child: WorkspaceTab = {
  kind: 'element',
  id: 'thread:child',
  tag: 'chat-thread-panel',
  icon: 'thread',
  title: 'Old name',
  element: {},
  props: { projectId: 'project', threadId: 'child' },
};
const file: WorkspaceTab = {
  kind: 'element',
  id: 'file:index',
  tag: 'files-viewer',
  icon: 'file',
  title: 'index.ts',
  element: {},
};
const tabs: WorkspaceTabs = { items: [file, child], selected: child.id };

// conversation-footer T-11.6 (D15): the element's tag decides, not the icon.
test('a tab shows a Thread exactly when its element is <chat-thread-panel>', () => {
  const panel: WorkspaceTab = {
    kind: 'element',
    id: 'thread:other',
    tag: 'chat-thread-panel',
    title: 'Other',
    element: {},
  };
  assert.equal(
    isThreadPanelTab(child),
    true,
    'a Thread panel with the Thread icon',
  );
  assert.equal(isThreadPanelTab(panel), true, 'a Thread panel with no icon');
  assert.equal(
    isThreadPanelTab({ ...file, icon: 'thread' }),
    false,
    'another element with the Thread icon',
  );
  assert.equal(
    isThreadPanelTab({
      id: 'f',
      kind: 'file',
      path: 'README.md',
      projectId: 'project',
    }),
    false,
    'a file tab',
  );
  assert.equal(
    isThreadPanelTab({ id: 't', kind: 'terminal', terminalId: 'x' }),
    false,
    'a terminal tab',
  );
});

test('renaming an open child updates its labels while preserving its mounted conversation and selection', () => {
  const renamed = reconcileThreadTabs(
    tabs,
    withThreads(emptyTree, 'project', [thread('New name')]),
    new Set(),
  );
  const tab = renamed.items[1];
  assert.equal(tab?.kind, 'element');
  if (tab?.kind !== 'element' || child.kind !== 'element') return;
  assert.equal(tab.title, 'New name');
  assert.equal(tab.ariaLabel, 'New name');
  assert.equal(tab.tooltip, 'New name');
  assert.equal(tab.element, child.element);
  assert.equal(renamed.selected, child.id);
  assert.equal(renamed.items[0], file);
  const unnamed = reconcileThreadTabs(
    renamed,
    withThreads(emptyTree, 'project', [thread('')]),
    new Set(),
  );
  assert.equal(
    unnamed.items[1]?.kind === 'element' && unnamed.items[1].title,
    'Untitled',
  );
});

test('only confirmed thread removal closes its tab and selects the remaining file', () => {
  assert.equal(reconcileThreadTabs(tabs, emptyTree, new Set()), tabs);
  const described = withThreads(emptyTree, 'project', []);
  assert.equal(
    reconcileThreadTabs(tabs, described, new Set(['project'])),
    tabs,
  );
  const removed = reconcileThreadTabs(tabs, described, new Set());
  assert.deepEqual(removed.items, [file]);
  assert.equal(removed.selected, file.id);
});

test('tree lifecycle disposes a deleted thread view and stops observing after cleanup', () => {
  workspaceStore.setState({
    tree: emptyTree,
    loadingProjectThreads: new Set(),
  });
  workspaceTabsStore.setState({ threads: { parent: tabs } });
  const disposed: object[] = [];
  const stop = watchThreadTabs({
    dispose: (element) => {
      disposed.push(element);
    },
  });
  try {
    workspaceStore.getState().applyThreads('project', [thread('Renamed')]);
    const renamed = workspaceTabsStore.getState().threads.parent?.items[1];
    assert.equal(renamed?.kind === 'element' && renamed.title, 'Renamed');
    assert.equal(disposed.length, 0);
    workspaceStore.getState().forgetThread('project', 'child');
    assert.deepEqual(workspaceTabsStore.getState().threads.parent?.items, [
      file,
    ]);
    assert.deepEqual(disposed, [child.element]);
    stop();
    workspaceTabsStore.setState({ threads: { parent: tabs } });
    workspaceStore.getState().applyThreads('project', []);
    assert.equal(workspaceTabsStore.getState().threads.parent, tabs);
  } finally {
    stop();
    workspaceTabsStore.setState({ threads: {} });
    workspaceStore.setState({ tree: emptyTree });
  }
});
