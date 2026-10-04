import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closeManual,
  closeTab,
  emptyTabs,
  openManual,
  openTab,
  removeTerminal,
  type WorkspaceTab,
} from '../src/domain/workspace-tabs.js';

const file: WorkspaceTab = {
  kind: 'file',
  id: 'file:a',
  path: 'a.ts',
  projectId: 'project',
};
const terminal: WorkspaceTab = {
  kind: 'terminal',
  id: 'terminal:one',
  terminalId: 'one',
};

test('manual shells open together and reopening one selects it without duplicating tabs', () => {
  const state = openManual(openManual(emptyTabs, 'one'), 'two');
  const selected = openManual(state, 'one');
  assert.deepEqual(selected.manualIds, ['one', 'two']);
  assert.equal(selected.manualId, 'one');
  assert.deepEqual(selected.items, []);
});

test('hiding manual shells preserves tabs and closing a tab selects another only when necessary', () => {
  const state = openManual(openManual(openTab(emptyTabs, file), 'one'), 'two');
  const hidden = openManual(state);
  assert.equal(hidden.manualId, undefined);
  assert.deepEqual(hidden.manualIds, ['one', 'two']);
  assert.equal(closeManual(state, 'one').manualId, 'two');
  const remaining = closeManual(state, 'two');
  assert.equal(remaining.manualId, 'one');
  assert.deepEqual(remaining.items, [file]);
  assert.equal(closeManual(remaining, 'one').manualId, undefined);
  assert.deepEqual(closeManual(remaining, 'one').manualIds, []);
});

test('discarding the selected manual shell selects another and preserves agent and file tabs', () => {
  const state = openManual(
    openManual(openTab(openTab(emptyTabs, file), terminal), 'one'),
    'two',
  );
  const remaining = removeTerminal(state, 'two');
  assert.equal(remaining.manualId, 'one');
  assert.deepEqual(remaining.manualIds, ['one']);
  assert.deepEqual(remaining.items, [file, terminal]);
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

test('removing a completed terminal keeps the file tabs and other manual shell open', () => {
  const opened = {
    ...openTab(openTab(emptyTabs, file), terminal),
    manualId: 'manual',
  };
  const remaining = removeTerminal(opened, 'one');
  assert.deepEqual(remaining.items, [file]);
  assert.equal(remaining.manualId, 'manual');
  assert.equal(removeTerminal(remaining, 'manual').manualId, undefined);
});
