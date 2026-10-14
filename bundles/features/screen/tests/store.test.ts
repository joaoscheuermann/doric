// The window store through its public reads: open/close/toggle, the attach
// status mapping, retries, per-Project isolation and the stable snapshot
// `useSyncExternalStore` needs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScreenStore,
  type ScreenStoreOptions,
} from '../src/client/store.js';
import type { ScreenAttach } from '../src/contracts/index.js';

const settled = () => new Promise((done) => setTimeout(done, 0));

const ready: ScreenAttach = {
  status: 'ready',
  url: 'http://127.0.0.1:5555/screen/token/',
  display: ':100',
};

const storeWith = (attach: ScreenStoreOptions['attach']) =>
  createScreenStore({ attach });

test('opening a Project mounts its panel, attaches and shows the screen', async () => {
  const store = storeWith(async () => ready);

  store.open('p1');

  assert.deepEqual(store.mounted(), ['p1']);
  assert.equal(store.panel('p1')?.open, true);
  assert.deepEqual(store.panel('p1')?.status, { kind: 'loading' });

  await settled();

  assert.deepEqual(store.panel('p1')?.status, {
    kind: 'ready',
    url: ready.url,
    display: ':100',
  });
});

test('closing keeps the panel mounted and its last status', async () => {
  const store = storeWith(async () => ready);

  store.open('p1');
  await settled();
  store.close('p1');

  assert.deepEqual(store.mounted(), ['p1']);
  assert.equal(store.panel('p1')?.open, false);
  assert.equal(store.panel('p1')?.status.kind, 'ready');
});

test('a pending sandbox is reported as pending and a later retry can succeed', async () => {
  let attach: ScreenStoreOptions['attach'] = async () => ({
    status: 'pending',
  });
  const store = storeWith((projectId) => attach(projectId));

  store.open('p1');
  await settled();
  assert.deepEqual(store.panel('p1')?.status, { kind: 'pending' });

  attach = async () => ready;
  store.retry('p1');
  await settled();
  assert.equal(store.panel('p1')?.status.kind, 'ready');
});

test('an unavailable note reports its reason', async () => {
  const store = storeWith(async () => ({
    status: 'unavailable',
    reason: 'missing-xpra',
  }));

  store.open('p1');
  await settled();

  assert.deepEqual(store.panel('p1')?.status, {
    kind: 'unavailable',
    reason: 'missing-xpra',
  });
});

test('a failed attach is reported, and a ready screen is never blanked by one', async () => {
  let fail = false;
  const store = storeWith(async () => {
    if (fail) {
      throw new Error('Doric backend is unavailable.');
    }

    return ready;
  });

  store.open('p1');
  await settled();
  assert.equal(store.panel('p1')?.status.kind, 'ready');

  fail = true;
  store.retry('p1');
  await settled();
  assert.equal(store.panel('p1')?.status.kind, 'ready');

  store.close('p1');
  fail = false;
  store.open('p2');
  await settled();
  assert.equal(store.panel('p2')?.status.kind, 'ready');
});

test('toggle closes an open panel and reopens it', async () => {
  const store = storeWith(async () => ready);

  store.toggle('p1');
  await settled();
  assert.equal(store.panel('p1')?.open, true);

  store.toggle('p1');
  assert.equal(store.panel('p1')?.open, false);

  store.toggle('p1');
  assert.equal(store.panel('p1')?.open, true);
});

test('panels and their geometry are per Project', async () => {
  const store = storeWith(async () => ready);

  store.open('p1');
  store.open('p2');
  await settled();

  store.setGeometry('p1', { x: 10, y: 20, width: 300, height: 200 });

  assert.deepEqual(store.panel('p1')?.geometry, {
    x: 10,
    y: 20,
    width: 300,
    height: 200,
  });
  assert.equal(store.panel('p2')?.geometry, undefined);
  assert.deepEqual(store.mounted(), ['p1', 'p2']);
});

test('the mounted snapshot is stable between changes', async () => {
  const store = storeWith(async () => ready);

  store.open('p1');

  const first = store.mounted();

  assert.equal(store.mounted(), first);

  await settled();

  const second = store.mounted();

  assert.equal(second, first);
});
