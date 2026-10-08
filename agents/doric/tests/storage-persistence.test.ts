import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createConfigStore } from '../src/lib/config/store.js';
import { createProjectStore } from '../src/lib/workspace/projects.js';
import { createThreadStore } from '../src/lib/workspace/threads.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

void test('PostgreSQL retains storage pauses, history, and FIFO across reconciliation and a fresh client', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const fixture = await persistenceFixture(connectionString);
  try {
    const projects = createProjectStore(fixture.database);
    const threads = createThreadStore(fixture.database);
    const { project } = await projects.create(
      'Storage',
      await createConfigStore(fixture.database).load(),
      'blue',
    );
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
    await threads.saveMessages(thread.id, [
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
    const restarted = createThreadStore(fixture.second);
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
    assert.deepEqual((await restarted.find(thread.id))?.messages, [
      { role: 'user', content: 'current' },
    ]);
  } finally {
    await fixture.close();
  }
});
