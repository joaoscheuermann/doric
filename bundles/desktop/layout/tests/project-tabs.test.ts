import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closeProjectTab,
  closeProjectTabs,
  emptyProjectTabs,
  parseProjectTabs,
  reconcileProjectTabs,
  rememberPath,
} from '../src/client/domain/project-tabs.js';

test('a Project tab remembers its last Thread and closing it leaves Home', () => {
  const first = rememberPath(emptyProjectTabs, '/projects/p1');
  const second = rememberPath(first, '/projects/p1/threads/t1');
  assert.deepEqual(second.order, ['p1']);
  assert.equal(second.paths.p1, '/projects/p1/threads/t1');
  assert.deepEqual(closeProjectTab(second, 'p1').order, []);
  assert.equal(second.homePath, '/');
});

test('invalid local paths and removed Projects are discarded', () => {
  const restored = parseProjectTabs(
    JSON.stringify({
      order: ['p1', 'p2'],
      paths: { p1: '/projects/p1', p2: '/projects/other' },
      homePath: '/projects',
    }),
  );
  assert.deepEqual(restored.order, ['p1']);
  assert.deepEqual(reconcileProjectTabs(restored, new Set()).order, []);
  assert.deepEqual(parseProjectTabs('{broken'), emptyProjectTabs);
  assert.deepEqual(
    parseProjectTabs(
      JSON.stringify({
        order: ['p1'],
        paths: { p1: '/projects/p1/threads/%broken' },
      }),
    ).order,
    [],
  );
});

test('reconciling keeps the same tabs when every Project still exists', () => {
  const opened = rememberPath(
    rememberPath(emptyProjectTabs, '/projects/p1/threads/t1'),
    '/projects/p2',
  );
  assert.equal(reconcileProjectTabs(opened, new Set(['p1', 'p2'])), opened);
  assert.deepEqual(reconcileProjectTabs(opened, new Set(['p2'])).order, ['p2']);
});

test('closing a group of tabs preserves the remaining order and paths', () => {
  const opened = ['p1', 'p2', 'p3'].reduce(
    (state, id) => rememberPath(state, `/projects/${id}`),
    emptyProjectTabs,
  );
  const closed = closeProjectTabs(opened, ['p1', 'p3']);
  assert.deepEqual(closed.order, ['p2']);
  assert.deepEqual(closed.paths, { p2: '/projects/p2' });
  assert.equal(closed.homePath, '/');
});

test('a fallback to a Project replaces a removed Thread in its remembered tab', () => {
  const opened = rememberPath(emptyProjectTabs, '/projects/p1/threads/deleted');

  const fallback = rememberPath(opened, '/projects/p1');

  assert.deepEqual(fallback.order, ['p1']);
  assert.equal(fallback.paths.p1, '/projects/p1');
});
