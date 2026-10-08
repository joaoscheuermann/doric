import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRefreshQueue } from '../src/queries/project-refresh';

test('coalesces a burst of mutations into one sandbox read', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const queue = createRefreshQueue(async () => {
    reads++;
  });
  const pending = [queue.request(), queue.request(), queue.request()];
  context.mock.timers.tick(250);
  await Promise.all(pending);
  assert.equal(reads, 1);
  queue.dispose();
});

test('reads again after a mutation arrives during an outstanding read', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let disk = 'old';
  let displayed = '';
  let finish: () => void = () => undefined;
  const queue = createRefreshQueue(async () => {
    const captured = disk;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    displayed = captured;
  });
  const initial = queue.request();
  context.mock.timers.tick(250);
  disk = 'new';
  const updated = queue.request();
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(250);
  finish();
  await Promise.all([initial, updated]);
  assert.equal(displayed, 'new');
  queue.dispose();
});

test('releases pending work when its owner is disposed', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const queue = createRefreshQueue(async () => {
    reads++;
  });
  const pending = queue.request();
  queue.dispose();
  context.mock.timers.tick(500);
  await pending;
  assert.equal(reads, 0);
});
