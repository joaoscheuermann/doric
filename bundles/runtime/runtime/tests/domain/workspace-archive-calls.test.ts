import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ContractError } from 'bundle/contracts';

import type { ThreadViewItem } from '../../src/contracts/watches.js';
import { memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  idleThread,
  isArchived,
  recordOf,
  scripted,
  settledTurn,
  unarchivedBeforeStart,
} from './support/archive.js';
import {
  createHarness,
  deferred,
  type Harness,
  type HarnessOptions,
} from './support/harness.js';

/*
 * archiveThread, restoreThread, setThreadPinned and viewThread through the
 * running service, and the inputs that un-archive a Thread before it runs
 * (docs/designs/thread-archive.md T-8, T-14 … T-16, T-33, T-36, T-37). No
 * case here sweeps, so `Date` runs free.
 */

const family = async (options: HarnessOptions = {}) => {
  const script = scripted();
  const harness = createHarness({ execute: script.execute, ...options });
  const project = await harness.readyProject();
  const main = await harness.createThread(project.id);
  return { harness, script, project, main };
};

const holding = async (
  harness: Harness,
  script: ReturnType<typeof scripted>,
  mainId: string,
) => {
  assert.equal(
    (await harness.service.threads.prompt(mainId, 'hold')).status,
    'accepted',
  );
  return script.controls;
};

/** A view's stream as the listener saw it. */
const observe = (harness: Harness, id: string) => {
  const items: ThreadViewItem[] = [];
  const ends: (ContractError | undefined)[] = [];
  const view = harness.service.threads.view(id, {
    next: (item) => items.push(item),
    end: (error) => ends.push(error),
  });
  return { view, items, ends };
};

const archive = async (harness: Harness, id: string) => {
  const archived = await harness.service.threads.archive(id);
  assert.equal(archived.status, 'archived');
  return archived;
};

void test('T-8 a retry un-archives an archived child before its run', {
  timeout: 15_000,
}, async () => {
  const { harness, script, main } = await family();
  try {
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    const first = await settledTurn(harness, child);
    await archive(harness, child);

    const from = harness.notices.length;
    assert.equal(
      (await harness.service.threads.retry(child)).status,
      'accepted',
    );
    await settledTurn(harness, child, first.result?.promptId);
    unarchivedBeforeStart(harness, from, child);
    assert.equal(await isArchived(harness, child), false);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-8 a parent’s restart of a failed child un-archives it before its run', {
  timeout: 15_000,
}, async () => {
  const { harness, script, main } = await family();
  try {
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    const first = await settledTurn(harness, child);
    await harness.service.threads.failTerminalResult(child);
    await harness.threadState(child, 'failed');
    await archive(harness, child);

    const from = harness.notices.length;
    assert.equal((await controls.restart(child)).status, 'accepted');
    await settledTurn(harness, child, first.result?.promptId);
    unarchivedBeforeStart(harness, from, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

/**
 * A first process that leaves an agent child with an unfinished `gated`
 * prompt (stopped by the host) and, optionally, a paused queue holding one
 * more prompt; the child is archived in storage afterwards.
 */
const stoppedChild = async (pausedQueue: boolean) => {
  const backend = memoryBackend();
  const {
    harness: first,
    script,
    project,
    main,
  } = await family({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const controls = await holding(first, script, main.id);
  const { threadId: child, promptId } = await controls.spawn('gated');
  await first.waitFor(() => script.waiting() === 1, 'the child to run');
  if (pausedQueue) {
    assert.equal(
      await first.service.threads.interrupt(child, promptId),
      'interrupted',
    );
    await settledTurn(first, child);
    assert.equal((await controls.send(child, 'task')).status, 'accepted');
    assert.equal((await first.service.threads.queue(child))?.paused, true);
  }
  script.release();
  await first.service.dispose();
  await first.dispose();
  return { backend, project, main, child, promptId };
};

/** A second process over `backend` whose sandbox acquisition waits for `gate`. */
const nextBoot = (
  backend: ReturnType<typeof memoryBackend>,
  gate: Promise<void> = Promise.resolve(),
) => {
  const script = scripted();
  const harness = createHarness({
    backend,
    execute: script.execute,
    sandbox: {
      acquire: async () => {
        await gate;
        return {
          sandbox: fakeSandbox(),
          release: async () => undefined,
        } as never;
      },
    },
  });
  return { harness, script };
};

const archiveStored = (harness: Harness, id: string) =>
  harness.stores.threads.archive([id], {
    at: new Date().toISOString(),
    batch: randomUUID(),
  });

void test('T-8 a Continue on a new service un-archives the child before its run', {
  timeout: 20_000,
}, async () => {
  const { backend, child, promptId } = await stoppedChild(false);
  const acquired = deferred();
  const { harness, script } = nextBoot(backend, acquired.promise);
  try {
    await archiveStored(harness, child);
    assert.equal(await isArchived(harness, child), true);

    const resumed = harness.service.threads.resume(child, promptId);
    await harness.waitFor(() => harness.sandbox.acquired.length === 1);
    acquired.resolve();
    assert.notEqual((await resumed).status, 'unknown_prompt');
    await harness.waitFor(() => script.waiting() === 1, 'the child to run');
    unarchivedBeforeStart(harness, 0, child);
    script.open();
    await settledTurn(harness, child);
  } finally {
    acquired.resolve();
    script.release();
    await harness.dispose();
    await backend.close();
  }
});

void test('T-8 a boot resume un-archives the child before the sandbox lease is set', {
  timeout: 20_000,
}, async () => {
  const { backend, child } = await stoppedChild(false);
  const acquired = deferred();
  const { harness, script } = nextBoot(backend, acquired.promise);
  try {
    await archiveStored(harness, child);

    assert.ok((await harness.service.resumeInterrupted()) >= 1);
    // The acquisition is still held: no run can have started.
    await harness.waitFor(
      async () => !(await isArchived(harness, child)),
      'the child to be un-archived',
    );
    assert.ok(
      harness.notices.some(
        (notice) =>
          notice.kind === 'threadUpdated' &&
          notice.value.id === child &&
          notice.value.archivedAt === undefined,
      ),
    );
    assert.equal(
      harness
        .events()
        .some(
          (event) =>
            event.threadId === child && event.type === 'prompt.started',
        ),
      false,
    );
    acquired.resolve();
    await harness.waitFor(() => script.waiting() >= 1, 'the child to run');
    script.open();
    await settledTurn(harness, child);
  } finally {
    acquired.resolve();
    script.release();
    while (script.waiting() > 0) script.open();
    await harness.dispose();
    await backend.close();
  }
});

void test('T-8 a queue resume un-archives the child before its run', {
  timeout: 20_000,
}, async () => {
  const { backend, child } = await stoppedChild(true);
  const { harness, script } = nextBoot(backend);
  try {
    await archiveStored(harness, child);
    const stopped = await recordOf(harness, child);

    assert.equal(
      (await harness.service.threads.resumeQueue(child)).status,
      'resumed',
    );
    await settledTurn(harness, child, stopped.result?.promptId);
    unarchivedBeforeStart(harness, 0, child);
  } finally {
    script.release();
    await harness.dispose();
    await backend.close();
  }
});

void test('T-14 archiveThread refuses a busy target, cascades over idle descendants and refuses an archived one', {
  timeout: 15_000,
}, async () => {
  const { harness, script, main } = await family();
  try {
    const controls = await holding(harness, script, main.id);
    assert.deepEqual(await harness.service.threads.archive(main.id), {
      status: 'busy',
    });
    const { threadId: one } = await controls.spawn('task');
    const { threadId: two } = await controls.spawn('task');
    const { threadId: running } = await controls.spawn('gated');
    await settledTurn(harness, one);
    await settledTurn(harness, two);
    await harness.waitFor(() => script.waiting() === 1, 'the running child');
    script.release();
    await idleThread(harness, main.id);

    const archived = await archive(harness, main.id);
    const ids =
      archived.status === 'archived'
        ? archived.threads.map((thread) => thread.id)
        : [];
    assert.equal(ids[0], main.id);
    assert.deepEqual(ids.slice(1).sort(), [one, two].sort());
    for (const id of [main.id, one, two])
      assert.equal(await isArchived(harness, id), true, id);
    assert.equal(await isArchived(harness, running), false);
    assert.deepEqual(await harness.service.threads.archive(main.id), {
      status: 'already_archived',
    });

    // One member wakes; Restore with the batch restores the rest.
    const before = await recordOf(harness, one);
    assert.equal((await harness.service.threads.retry(one)).status, 'accepted');
    await settledTurn(harness, one, before.result?.promptId);
    await idleThread(harness, main.id);
    const batch = archived.status === 'archived' ? archived.batch : '';
    const restored = await harness.service.threads.restore(main.id, batch);
    assert.equal(restored.status, 'restored');
    const restoredIds =
      restored.status === 'restored'
        ? restored.threads.map((thread) => thread.id)
        : [];
    assert.ok(restoredIds.includes(two));
    assert.equal(restoredIds.includes(one), false);
    for (const id of [main.id, one, two])
      assert.equal(await isArchived(harness, id), false, id);
  } finally {
    script.release();
    while (script.waiting() > 0) script.open();
    await harness.dispose();
  }
});

void test('T-14 archiveThread, restoreThread and setThreadPinned answer for missing and unarchived Threads', {
  timeout: 15_000,
}, async () => {
  const { harness, main } = await family();
  try {
    assert.deepEqual(await harness.service.threads.archive(randomUUID()), {
      status: 'missing',
    });
    assert.deepEqual(await harness.service.threads.restore(randomUUID()), {
      status: 'missing',
    });
    assert.deepEqual(await harness.service.threads.restore(main.id), {
      status: 'not_archived',
    });
    assert.deepEqual(
      await harness.service.threads.restore(main.id, randomUUID()),
      { status: 'not_archived' },
    );
    assert.equal(
      await harness.service.threads.setPinned(randomUUID(), true),
      undefined,
    );
    const pinned = await harness.service.threads.setPinned(main.id, true);
    assert.equal(pinned?.pinned, true);
    const unpinned = await harness.service.threads.setPinned(main.id, false);
    assert.equal(unpinned !== undefined && 'pinned' in unpinned, false);
  } finally {
    await harness.dispose();
  }
});

void test('T-15 deleteThread deletes a terminated archived agent thread and refuses a non-archived one', {
  timeout: 15_000,
}, async () => {
  const { harness, script, main } = await family();
  try {
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('gated');
    await harness.waitFor(() => script.waiting() === 1, 'the child to run');
    await controls.terminate(child);
    await harness.threadState(child, 'cancelled');
    assert.equal(await harness.service.threads.delete(child), 'forbidden');

    await archive(harness, child);
    assert.equal(await harness.service.threads.delete(child), 'deleted');
    assert.equal(await harness.stores.threads.record(child), undefined);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-16 archive, restore, pin and view leave updatedAt and the Project order unchanged', {
  timeout: 15_000,
}, async () => {
  const pause = () => new Promise((done) => setTimeout(done, 5));
  const { harness } = await family();
  try {
    const older = await harness.readyProject('Older');
    const thread = await harness.createThread(older.id);
    await pause();
    const newer = await harness.readyProject('Newer');
    await harness.createThread(newer.id);
    await pause();
    const order = async () =>
      (await harness.service.projects.activity()).map((entry) => [
        entry.project.id,
        entry.activityAt,
      ]);
    const before = await order();
    const updatedAt = (await recordOf(harness, thread.id)).updatedAt;

    await archive(harness, thread.id);
    await pause();
    assert.equal(
      (await harness.service.threads.restore(thread.id)).status,
      'restored',
    );
    await pause();
    await harness.service.threads.setPinned(thread.id, true);
    await pause();
    const { view, items } = observe(harness, thread.id);
    await harness.waitFor(() => items.length === 1, 'the view');
    view.dispose();
    await harness.waitFor(
      async () =>
        (await harness.stores.threads.archiveStates(older.id)).some(
          (state) =>
            state.thread.id === thread.id && state.viewedAt !== undefined,
        ),
      'the view to be written',
    );

    assert.deepEqual(await order(), before);
    assert.equal((await recordOf(harness, thread.id)).updatedAt, updatedAt);
  } finally {
    await harness.dispose();
  }
});

void test('T-33 a drain ends every view with unavailable, arms no sweep and ends later views at once', {
  timeout: 15_000,
}, async () => {
  const { harness, main } = await family();
  try {
    const one = observe(harness, main.id);
    const two = observe(harness, main.id);
    await harness.waitFor(
      () => one.items.length === 1 && two.items.length === 1,
      'both views',
    );
    await harness.service.handover.drain(() => undefined);
    await harness.waitFor(
      () => one.ends.length === 1 && two.ends.length === 1,
      'both views to end',
    );
    for (const { ends } of [one, two])
      assert.equal(ends[0]?.code, 'unavailable');
    assert.equal(harness.armedSweeps(), 0);

    const late = observe(harness, main.id);
    await harness.waitFor(() => late.ends.length === 1, 'the late view to end');
    assert.equal(late.ends[0]?.code, 'unavailable');
    assert.deepEqual(late.items, []);
  } finally {
    await harness.dispose();
  }
});

void test('T-36 an archive over the storage batch limit rejects, writes nothing and logs it', {
  timeout: 15_000,
}, async () => {
  const backend = memoryBackend({ maxBatch: 4 });
  const harness = createHarness({ backend });
  try {
    const project = await harness.readyProject();
    const parent = await harness.createThread(project.id);
    const one = await harness.createThread(project.id, parent.id);
    const two = await harness.createThread(project.id, parent.id);

    await assert.rejects(harness.service.threads.archive(parent.id), {
      code: 'limit_exceeded',
    });
    for (const id of [parent.id, one.id, two.id])
      assert.equal(await isArchived(harness, id), false, id);
    assert.ok(
      harness.logs.some(
        ({ message }) => message === 'Archive exceeds the storage batch limit',
      ),
    );
  } finally {
    await harness.dispose();
    await backend.close();
  }
});

void test('T-37 viewThread of an unknown Thread ends with not_found and emits nothing', {
  timeout: 15_000,
}, async () => {
  const { harness } = await family();
  try {
    const missing = observe(harness, randomUUID());
    await harness.waitFor(() => missing.ends.length === 1, 'the view to end');
    assert.equal(missing.ends[0]?.code, 'not_found');
    assert.deepEqual(missing.items, []);
  } finally {
    await harness.dispose();
  }
});
