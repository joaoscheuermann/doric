import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  checkDisk,
  StoragePressureError,
  storageFull,
} from '../src/lib/workspace/disk.js';
import { ThreadPersistenceError } from '../src/lib/workspace/runtime.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { deferred, fakeSandbox, pool, workspace } from './helpers/workspace.js';

void test('storage pauses at or below ten percent and refuses an unreadable filesystem', async () => {
  for (const bavail of [0n, 9n, 10n])
    await assert.rejects(
      checkDisk('/database', async () => ({ blocks: 100n, bavail })),
      StoragePressureError,
    );
  await checkDisk('/database', async () => ({ blocks: 100n, bavail: 11n }));
  await assert.rejects(
    checkDisk('/missing', async () => {
      throw new Error('missing mount');
    }),
    StoragePressureError,
  );
  await assert.rejects(
    checkDisk('/unknown', async () => ({ blocks: 0n, bavail: 0n })),
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
  const harness = workspace();
  let low = true;
  const ran: string[] = [];
  const drained = deferred();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    checkStorage: async () => {
      if (low) throw new StoragePressureError();
    },
    execute: async ({ job }) => {
      ran.push(job.prompt);
      if (job.prompt === 'second') drained.resolve();
      return 'done';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    await service.threads.prompt(id, 'first');
    await setImmediate();
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
      harness.events.some((event) => event.type === 'prompt.finished'),
      false,
    );
    low = false;
    assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
    await drained.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(ran, ['first', 'second']);
    assert.equal((await service.threads.queue(id))?.error, undefined);
  } finally {
    await service.dispose();
  }
});

void test('a full database preserves the active checkpoint, reports a pause and flushes before resuming the same prompt', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  let full = false;
  let recovered = false;
  let checkpoint = false;
  const finished = deferred();
  const started: string[] = [];
  const append = harness.threads.appendEvents;
  harness.threads.appendEvents = async (...args) => {
    if (full) throw { code: '53100' };
    return append(...args);
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    execute: async ({ job }) => {
      started.push(job.id);
      if (!recovered) {
        full = true;
        throw new ThreadPersistenceError({ code: '53100' }, async () => {
          if (full) throw { code: '53100' };
          checkpoint = true;
        });
      }
      assert.equal(checkpoint, true);
      finished.resolve();
      return 'recovered';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const id = created.thread.id;
    const accepted = await service.threads.prompt(id, 'important work');
    if (accepted.status !== 'accepted') throw new Error('Prompt unavailable');
    await setImmediate();
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.stopping, false);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.equal((await service.threads.resumeQueue(id)).status, 'storage_low');
    assert.equal(
      harness.events.some((event) => event.type === 'prompt.finished'),
      false,
    );
    full = false;
    recovered = true;
    assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
    await finished.promise;
    await harness.threadState(id, 'ready');
    assert.deepEqual(started, [accepted.promptId, accepted.promptId]);
    assert.ok(
      harness.events.some(
        (event) =>
          event.type === 'prompt.paused' &&
          (event.event as { reason: string }).reason === 'storage_low',
      ),
    );
  } finally {
    full = false;
    await service.dispose();
  }
});

void test('storage-paused work survives service restart without automatic execution', {
  timeout: 5000,
}, async () => {
  const harness = workspace();
  const options = {
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
  };
  const first = createWorkspaceService({
    ...options,
    checkStorage: async () => {
      throw new StoragePressureError();
    },
    execute: async () => 'unexpected',
  });
  const project = await first.projects.create('Project');
  const created = await first.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  await first.threads.prompt(created.thread.id, 'important work');
  await setImmediate();
  await first.dispose();
  const second = createWorkspaceService({
    ...options,
    execute: async () => 'unexpected',
  });
  try {
    assert.equal(await second.resumeInterrupted(), 0);
    const queue = await second.threads.queue(created.thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.error?.code, 'storage_low');
    assert.equal(
      harness.events.some((event) => event.type === 'prompt.started'),
      false,
    );
  } finally {
    await second.dispose();
  }
});

void test('storage pressure during a long execution cancels the wait and leaves its prompt resumable ahead of FIFO', {
  timeout: 5000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const harness = workspace();
  const started = deferred();
  let low = false;
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, fakeSandbox()),
    checkStorage: async () => {
      if (low) throw new StoragePressureError();
    },
    execute: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return 'unexpected';
    },
  });
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
    await setImmediate();
    const queue = await service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, accepted.promptId);
    assert.deepEqual(
      queue?.items.map((item) => item.preview),
      ['next'],
    );
    assert.equal(
      harness.events.some((event) => event.type === 'prompt.finished'),
      false,
    );
  } finally {
    await service.dispose();
  }
});
