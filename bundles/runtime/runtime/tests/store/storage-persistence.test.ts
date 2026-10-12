import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  connectionString,
  postgresBackend,
  saveMessages,
  snapshot,
  stores,
} from './support.js';

// Ported from agents/doric/tests/storage-persistence.test.ts (57-WP-K): the
// same scenario over the runtime's stores on PostgreSQL, with a second
// storage client standing for the fresh client of a restarted host.

void test('PostgreSQL retains storage pauses, history, and FIFO across reconciliation and a fresh client', {
  skip: connectionString === undefined,
}, async () => {
  const backend = await postgresBackend();
  try {
    const { projects, threads } = stores(backend.storage);
    const { project } = await projects.create('Storage', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Important');
    const promptId = randomUUID();
    const next = randomUUID();
    await threads.appendEvent(thread.id, promptId, {
      type: 'prompt.accepted',
      text: 'current',
      source: { kind: 'user' },
    });
    await threads.setState(thread.id, 'running', promptId);
    await threads.appendEvent(thread.id, promptId, { type: 'prompt.started' });
    await saveMessages(threads, thread.id, [
      { role: 'user', content: 'current' },
    ]);
    await threads.appendEvent(thread.id, next, {
      type: 'prompt.accepted',
      text: 'next',
      queued: true,
      source: { kind: 'user' },
    });
    await threads.appendEvents(thread.id, promptId, [
      { type: 'queue.paused', reason: 'storage_low' },
      { type: 'prompt.paused', reason: 'storage_low' },
    ]);
    const restarted = stores(backend.second()).threads;
    await restarted.reconcile();
    const queue = await restarted.queue(thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.equal(queue?.resumable?.promptId, promptId);
    assert.deepEqual(
      queue?.items.map((item) => item.promptId),
      [next],
    );
    assert.equal((await restarted.record(thread.id))?.state, 'ready');
    assert.deepEqual(
      await (await restarted.history(thread.id)).read('messages'),
      [{ role: 'user', content: 'current' }],
    );
  } finally {
    await backend.close();
  }
});
