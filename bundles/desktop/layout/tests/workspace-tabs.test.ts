import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closeTab,
  emptyTabs,
  moveTab,
  openTab,
  type WorkspaceTab,
} from '../src/client/domain/workspace-tabs.js';

// Every tab is an element tab another bundle opened (bundle isolation 4a,
// change 6): the file, terminal and comparison tabs are drawn by their bundles.
const file: WorkspaceTab = {
  kind: 'element',
  id: 'file:a',
  tag: 'files-file-view',
  title: 'a.ts',
  element: {},
  props: { projectId: 'project', path: 'a.ts' },
};
const terminal: WorkspaceTab = {
  kind: 'element',
  id: 'terminal:one',
  tag: 'terminal-view',
  title: 'one',
  element: {},
  props: { terminalId: 'one' },
};

test('reorders tabs in either direction without changing selection or their content', () => {
  const third: WorkspaceTab = {
    ...file,
    id: 'file:b',
    title: 'b.ts',
    props: { projectId: 'project', path: 'b.ts' },
  };
  const state = openTab(openTab(openTab(emptyTabs, file), terminal), third);
  const moved = moveTab(state, file.id, third.id);
  assert.deepEqual(moved.items, [terminal, third, file]);
  assert.equal(moved.selected, third.id);
  assert.deepEqual(moveTab(moved, file.id, terminal.id).items, state.items);
  assert.deepEqual(state.items, [file, terminal, third]);
  assert.deepEqual(moveTab(state, 'closed', file.id), state);
  assert.deepEqual(moveTab(state, file.id, 'closed'), state);
  assert.deepEqual(moveTab(state, file.id, file.id), state);
});

test('opens a comparison alongside its file and reselects it without duplication', () => {
  const diff: WorkspaceTab = {
    kind: 'element',
    id: 'diff:a',
    tag: 'git-file-diff',
    title: 'a.ts',
    element: {},
    props: { projectId: 'project', repository: '', path: 'a.ts' },
  };
  const state = openTab(openTab(openTab(emptyTabs, file), diff), terminal);
  const selected = openTab(state, diff);
  assert.equal(selected.selected, diff.id);
  assert.deepEqual(selected.items, [file, diff, terminal]);
  assert.deepEqual(closeTab(selected, diff.id).items, [file, terminal]);
});

test('opens files and terminals together and selects an existing tab without duplicating it', () => {
  const opened = openTab(openTab(emptyTabs, file), terminal);
  const selected = openTab(opened, file);
  assert.deepEqual(selected.items, [file, terminal]);
  assert.equal(selected.selected, file.id);
});

test('closing the selected tab selects a remaining tab and closing the last empties the section', () => {
  const opened = openTab(openTab(emptyTabs, file), terminal);
  const remaining = closeTab(opened, terminal.id);
  assert.equal(remaining.selected, file.id);
  const closed = closeTab(remaining, file.id);
  assert.equal(closed.items.length, 0);
  assert.equal(closed.selected, undefined);
});
