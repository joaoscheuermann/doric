import assert from 'node:assert/strict';
import test from 'node:test';

import type { StorageHealth } from 'bundle/contracts';

import { ThreadPersistenceError } from '../../src/host/domain/runtime.js';
import {
  checkStorageHealth,
  StoragePressureError,
  storageFull,
} from '../../src/host/domain/storage-pressure.js';
import { memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred, type Harness } from './support/harness.js';

/*
 * Ported from agents/doric tests/storage-pressure.test.ts (design 57 §13.1,
 * stage 5 "Storage pressure", §4.7 as revised): the 10 % rule now reads
 * `storage/v1.health()`, and a persistence failure reaches the runtime
 * through the PromptSession the executor records with.
 */

const disk = (blocks: number, availableBlocks: number): StorageHealth => ({
  status: 'ok',
  writable: true,
  disk: { blocks, availableBlocks },
});

const healthy = disk(100, 50);

const logOf = async (harness: Harness, id: string) =>
  (await harness.service.threads.events(id, 0))?.events ?? [];

void test('storage pauses at or below ten percent and refuses an unmeasurable disk', async () => {
  for (const available of [0, 9, 10])
    await assert.rejects(
      checkStorageHealth({ health: async () => disk(100, available) }),
      StoragePressureError,
    );
  await checkStorageHealth({ health: async () => disk(100, 11) });
  await assert.rejects(
    checkStorageHealth({
      health: async () => {
        throw new Error('missing mount');
      },
    }),
    StoragePressureError,
  );
  await assert.rejects(
    checkStorageHealth({ health: async () => disk(0, 0) }),
    StoragePressureError,
  );
  await assert.rejects(
    checkStorageHealth({
      health: async () => ({ status: 'unavailable', writable: false }),
    }),
    StoragePressureError,
  );
});

void test('recognizes disk exhaustion through provider wrappers without misclassifying other persistence failures', () => {
  assert.equal(
    storageFull(new ThreadPersistenceError({ code: 'ENOSPC' })),
    true,
  );
  assert.equal(storageFull({ meta: { code: '53100' } }), true);
  assert.equal(
    storageFull(
      new ThreadPersistenceError(
        new Error('Database error. Code: `53100`. No space left on device'),
      ),
    ),
    true,
  );
  assert.equal(storageFull({ originalError: { code: 'ENOSPC' } }), true);
  assert.equal(
    storageFull(new ThreadPersistenceError({ code: '23505' })),
    false,
  );
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(storageFull(cyclic), false);
});

void test('low storage prevents dispatch, retains FIFO, and requires a healthy explicit resume', {
  timeout: 5000,
}, async () => {
  let low = true;
  const ran: string[] = [];
  const drained = deferred();
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    health: async () => (low ? disk(100, 5) : healthy),
    execute: async ({ job }) => {
      ran.push(job.prompt);
      if (job.prompt === 'second') drained.resolve();
      return 'done';
    },
  });
  const { service } = harness;
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    await service.threads.prompt(id, 'first');
    await harness.waitFor(
      async () => (await service.threads.queue(id))?.paused === true,
    );
    await service.threads.prompt(id, 'second');
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.deepEqual(
      queue?.items.map((item) => item.preview),
      ['first', 'second'],
    );
    assert.deepEqual(ran, []);
    assert.equal((await service.threads.resumeQueue(id)).status, 'storage_low');
    assert.equal(
      (await logOf(harness, id)).some(
        (event) => event.type === 'prompt.finished',
      ),
      false,
    );
    low = false;
    assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, ['first', 'second']);
    assert.equal((await service.threads.queue(id))?.error, undefined);
  } finally {
    await harness.dispose();
  }
});

void test('a full database preserves the active checkpoint, reports a pause and flushes before resuming the same prompt', {
  timeout: 5000,
}, async () => {
  let full = false;
  let recovered = false;
  const finished = deferred();
  const started: string[] = [];
  let flushedBeforeRetry = false;
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ job, session, thread }) => {
      started.push(job.id);
      if (!recovered) {
        full = true;
        // The run's event cannot be written: the session keeps it for retry.
        await session.record({ event: { type: 'text.delta', text: 'kept' } });
        return 'unreachable';
      }
      flushedBeforeRetry = (await logOf(harness, thread.id)).some(
        (event) =>
          event.type === 'text.delta' &&
          (event.event as { text?: string }).text === 'kept',
      );
      finished.resolve();
      return 'recovered';
    },
  });
  const { service } = harness;
  const append = harness.stores.threads.appendEvent;
  const appendAll = harness.stores.threads.appendEvents;
  harness.stores.threads.appendEvent = async (...args) => {
    if (full) throw { code: '53100' };
    return append(...args);
  };
  harness.stores.threads.appendEvents = async (...args) => {
    if (full) throw { code: '53100' };
    return appendAll(...args);
  };
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    await harness.projectState(project.id, 'ready');
    const accepted = await service.threads.prompt(id, 'important work');
    if (accepted.status !== 'accepted') throw new Error('Prompt unavailable');
    await harness.waitFor(
      async () => (await service.threads.queue(id))?.paused === true,
    );
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.stopping, false);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.equal((await service.threads.resumeQueue(id)).status, 'storage_low');
    assert.equal(
      (await logOf(harness, id)).some(
        (event) => event.type === 'prompt.finished',
      ),
      false,
    );
    full = false;
    recovered = true;
    assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
    await finished.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(started, [accepted.promptId, accepted.promptId]);
    assert.equal(flushedBeforeRetry, true);
    assert.ok(
      (await logOf(harness, id)).some(
        (event) =>
          event.type === 'prompt.paused' &&
          (event.event as { reason: string }).reason === 'storage_low',
      ),
    );
  } finally {
    full = false;
    await harness.dispose();
  }
});

void test('storage-paused work survives service restart without automatic execution', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const first = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    health: async () => disk(100, 1),
    execute: async () => 'unexpected',
  });
  const project = await first.service.projects.create('Project');
  const created = await first.service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  await first.projectState(project.id, 'ready');
  await first.service.threads.prompt(created.thread.id, 'important work');
  await first.waitFor(
    async () =>
      (await first.service.threads.queue(created.thread.id))?.paused === true,
  );
  await first.dispose();
  const second = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async () => 'unexpected',
  });
  try {
    assert.equal(await second.service.resumeInterrupted(), 0);
    const queue = await second.service.threads.queue(created.thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.equal(
      (await logOf(second, created.thread.id)).some(
        (event) => event.type === 'prompt.started',
      ),
      false,
    );
  } finally {
    await second.dispose();
    await backend.close();
  }
});

void test('storage pressure during a long execution cancels the wait and leaves its prompt resumable ahead of FIFO', {
  timeout: 5000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const started = deferred();
  let low = false;
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    health: async () => (low ? disk(100, 5) : healthy),
    execute: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal?.throwIfAborted();
      return 'unexpected';
    },
  });
  const { service } = harness;
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    const accepted = await service.threads.prompt(id, 'current');
    if (accepted.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;
    await service.threads.prompt(id, 'next');
    low = true;
    t.mock.timers.tick(3000);
    await harness.waitFor(
      async () => (await service.threads.queue(id))?.paused === true,
    );
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, accepted.promptId);
    assert.deepEqual(
      queue?.items.map((item) => item.preview),
      ['next'],
    );
    assert.equal(
      (await logOf(harness, id)).some(
        (event) => event.type === 'prompt.finished',
      ),
      false,
    );
  } finally {
    await harness.dispose();
  }
});
