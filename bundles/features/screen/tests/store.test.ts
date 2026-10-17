// The window's mirror of the desktop part's views: what it holds, the snapshot
// identity `useSyncExternalStore` needs, and when it notifies.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenViewsStore } from '../src/client/store.js';
import type { ScreenView } from '../src/contracts/index.js';

const waiting = (id: string): ScreenView => ({
  id,
  label: `Screen ${id}`,
  projectId: `p-${id}`,
  status: { kind: 'waiting' },
});

const withStatus = (
  view: ScreenView,
  status: ScreenView['status'],
): ScreenView => ({
  ...view,
  status,
});

void test('the snapshot keeps its identity until the list changes', () => {
  const store = createScreenViewsStore();
  const view = waiting('1');

  store.set([view]);

  const first = store.views();

  store.set([view]);

  assert.equal(store.views(), first);

  store.set([
    withStatus(view, { kind: 'ready', path: '/screen/a/', display: ':100' }),
  ]);

  assert.notEqual(store.views(), first);
});

void test('a ready view carries the host-relative path and its display', () => {
  const store = createScreenViewsStore();

  store.set([
    withStatus(waiting('1'), {
      kind: 'ready',
      path: '/screen/token/',
      display: ':100',
    }),
  ]);

  assert.deepEqual(store.views(), [
    {
      id: '1',
      label: 'Screen 1',
      projectId: 'p-1',
      status: { kind: 'ready', path: '/screen/token/', display: ':100' },
    },
  ]);
});

void test('an unchanged list notifies nobody, a changed one notifies once', () => {
  const store = createScreenViewsStore();
  const view = waiting('1');
  let notified = 0;
  const subscription = store.subscribe(() => {
    notified += 1;
  });

  store.set([view]);
  store.set([{ ...view }]);

  assert.equal(notified, 1);

  store.set([withStatus(view, { kind: 'failed' })]);

  assert.equal(notified, 2);

  subscription.dispose();
  store.set([view]);

  assert.equal(notified, 2);
});

void test('reset clears the list and notifies', () => {
  const store = createScreenViewsStore();
  let notified = 0;

  store.subscribe(() => {
    notified += 1;
  });

  store.set([waiting('1')]);
  store.reset();
  store.reset();

  assert.deepEqual(store.views(), []);
  assert.equal(notified, 2);
});
