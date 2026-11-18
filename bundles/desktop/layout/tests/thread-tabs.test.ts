import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyTree,
  type ProjectTree,
} from '../src/client/domain/project-tree.js';
import { THREAD_TAB_ICON } from '../src/client/domain/thread-navigation.js';
import type { Thread } from '../src/client/domain/workspace.js';
import {
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
/** The empty tree once the host has described the Threads of 'project'. */
const describedTree = (threads: readonly Thread[]): ProjectTree => ({
  ...emptyTree,
  threadsByProject: { project: threads },
});
const child: WorkspaceTab = {
  kind: 'element',
  id: 'thread:child',
  tag: 'chat-thread-panel',
  iconTag: 'chat-thread-tab-icon',
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

// bundle isolation 4a: a Thread tab is told by its icon element.
test('the Thread tab icon is the chat element chat-thread-tab-icon', () => {
  assert.equal(THREAD_TAB_ICON, 'chat-thread-tab-icon');
});

test('renaming an open child updates its labels while preserving its mounted conversation and selection', () => {
  const renamed = reconcileThreadTabs(
    tabs,
    describedTree([thread('New name')]),
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
    describedTree([thread('')]),
    new Set(),
  );
  assert.equal(
    unnamed.items[1]?.kind === 'element' && unnamed.items[1].title,
    'Untitled',
  );
});

test('only confirmed thread removal closes its tab and selects the remaining file', () => {
  assert.equal(reconcileThreadTabs(tabs, emptyTree, new Set()), tabs);
  const described = describedTree([]);
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
    workspaceStore.setState({ tree: describedTree([thread('Renamed')]) });
    const renamed = workspaceTabsStore.getState().threads.parent?.items[1];
    assert.equal(renamed?.kind === 'element' && renamed.title, 'Renamed');
    assert.equal(disposed.length, 0);
    workspaceStore.setState({ tree: describedTree([]) });
    assert.deepEqual(workspaceTabsStore.getState().threads.parent?.items, [
      file,
    ]);
    assert.deepEqual(disposed, [child.element]);
    stop();
    workspaceTabsStore.setState({ threads: { parent: tabs } });
    workspaceStore.setState({ tree: describedTree([]) });
    assert.equal(workspaceTabsStore.getState().threads.parent, tabs);
  } finally {
    stop();
    workspaceTabsStore.setState({ threads: {} });
    workspaceStore.setState({ tree: emptyTree });
  }
});
