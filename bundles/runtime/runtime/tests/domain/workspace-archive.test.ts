import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { DoricConfiguration } from '../../src/contracts/configuration.js';
import type { ThreadViewItem } from '../../src/contracts/watches.js';
import { finishedDelayMs } from '../../src/host/domain/archive.js';
import { projectGraceMs } from '../../src/host/domain/archiver.js';
import { memoryBackend } from '../store/support.js';
import {
  archivedSoon,
  archiveHarness,
  dayMs,
  goLive,
  isArchived,
  publishedArchived,
  recordOf,
  settledProject,
  settledTurn,
  sweepAfter,
  unarchivedBeforeStart,
} from './support/archive.js';
import {
  createHarness,
  defaultConfiguration,
  epoch,
  type Harness,
  type HarnessOptions,
} from './support/harness.js';

/*
 * The two archive rules through the running service
 * (docs/designs/thread-archive.md T-6, T-7, T-9 … T-13, T-17, T-31, T-32,
 * T-40): `Date` is mocked and every sweep is run by hand (D28), so each case
 * states its times exactly. A case that compares a restore with a later
 * result advances `Date` by 1 ms between them (D6 compares strictly).
 */

/** The configuration in force, with `threads.autoArchive` as given. */
const configured =
  (
    autoArchive: NonNullable<
      NonNullable<DoricConfiguration['configuration']['threads']>['autoArchive']
    >,
  ): (() => DoricConfiguration) =>
  () => ({
    configuration: { ...defaultConfiguration, threads: { autoArchive } },
    revision: 1,
    updatedAt: epoch,
  });

/** A live Project with one main thread, on mocked `Date`. */
const family = async (t: TestContext, options: HarnessOptions = {}) => {
  const { harness, script } = archiveHarness(t, options);
  const project = await harness.readyProject();
  const main = await harness.createThread(project.id);
  return { harness, script, project, main };
};

/** The main thread holds its prompt; its controls spawn and drive children. */
const holding = async (
  harness: Harness,
  script: ReturnType<typeof archiveHarness>['script'],
  mainId: string,
) => {
  assert.equal(
    (await harness.service.threads.prompt(mainId, 'hold')).status,
    'accepted',
  );
  return script.controls;
};

/** Holds a view of `id` and waits until the runtime holds it. */
const viewOf = async (harness: Harness, id: string) => {
  const items: ThreadViewItem[] = [];
  const view = harness.service.threads.view(id, {
    next: (item) => items.push(item),
  });
  await harness.waitFor(() => items.length === 1, `a view of ${id}`);
  assert.deepEqual(items, [{ kind: 'viewing', threadId: id }]);
  return view;
};

/** The latest createdAt or result time of the Project's Threads. */
const latestActivity = async (harness: Harness, projectId: string) =>
  Math.max(
    ...(await harness.stores.threads.listByProject(projectId)).flatMap(
      (thread) => [
        Date.parse(thread.createdAt),
        ...(thread.result === undefined ? [] : [Date.parse(thread.result.at)]),
      ],
    ),
  );

void test('T-6 an agent thread is not archived before 30 s after its turn and is by 40 s', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    await settledTurn(harness, child);

    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    assert.equal(publishedArchived(harness, child), false);

    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
    assert.equal(await isArchived(harness, main.id), false);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-7 a parent’s send un-archives the child before its run and it is archived again after the turn', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    const first = await settledTurn(harness, child);
    assert.equal(
      (await harness.service.threads.archive(child)).status,
      'archived',
    );

    const from = harness.notices.length;
    assert.equal((await controls.send(child, 'gated')).status, 'accepted');
    await harness.waitFor(() => script.waiting() === 1, 'the child to run');
    unarchivedBeforeStart(harness, from, child);
    t.mock.timers.tick(1);
    script.open();
    await settledTurn(harness, child, first.result?.promptId);

    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-9 a held view keeps an agent thread until 30 s after it ends', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    await settledTurn(harness, child);

    const view = await viewOf(harness, child);
    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    view.dispose();
    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-9 two views keep an agent thread until both end', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    await settledTurn(harness, child);

    const one = await viewOf(harness, child);
    const two = await viewOf(harness, child);
    one.dispose();
    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    two.dispose();
    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-10 pinned and failed-result children and the main thread are never archived by the agent-thread rule', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: pinned } = await controls.spawn('task');
    const { threadId: failed } = await controls.spawn('fail');
    const { threadId: plain } = await controls.spawn('task');
    for (const id of [pinned, failed, plain]) await settledTurn(harness, id);
    assert.equal((await recordOf(harness, failed)).result?.status, 'failed');
    assert.equal(
      (await harness.service.threads.setPinned(pinned, true))?.pinned,
      true,
    );

    await sweepAfter(t, harness, 60_000);
    await archivedSoon(harness, plain);
    await sweepAfter(t, harness, 60_000);
    for (const id of [pinned, failed, main.id])
      assert.equal(await isArchived(harness, id), false, id);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-11 the agent-thread toggle applies at the next sweep', {
  timeout: 30_000,
}, async (t) => {
  let agentThreads = false;
  const { harness, script, main } = await family(t, {
    configuration: () => configured({ agentThreads })(),
  });
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    await settledTurn(harness, child);

    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    agentThreads = true;
    await sweepAfter(t, harness, 10_000);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-12 an idle main thread is archived with its descendants in one batch after the configured days', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, project, main } = await family(t, {
    configuration: configured({ agentThreads: false }),
  });
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'spawn');
    await harness.waitFor(() => script.children.length === 1, 'the spawn');
    const [child] = script.children as [string];
    await settledProject(harness, project.id);
    const due = (await latestActivity(harness, project.id)) + 7 * dayMs;

    await sweepAfter(t, harness, due - 1 - Date.now());
    assert.equal(await isArchived(harness, main.id), false);
    assert.equal(await isArchived(harness, child), false);

    await sweepAfter(t, harness, 1 + 10_000);
    await archivedSoon(harness, main.id);
    await archivedSoon(harness, child);
    const states = await harness.stores.threads.archiveStates(project.id);
    const batchOf = (id: string) =>
      states.find((state) => state.thread.id === id)?.batch;
    const batch = batchOf(main.id);
    assert.ok(batch);
    assert.equal(batchOf(child), batch);

    const restored = await harness.service.threads.restore(main.id, batch);
    assert.equal(restored.status, 'restored');
    assert.deepEqual(
      restored.status === 'restored'
        ? restored.threads.map((thread) => thread.id).sort()
        : [],
      [main.id, child].sort(),
    );
  } finally {
    await harness.dispose();
  }
});

void test('T-12 never archives a main thread with mainThreadsAfter never', {
  timeout: 30_000,
}, async (t) => {
  const { harness, project, main } = await family(t, {
    configuration: configured({
      agentThreads: false,
      mainThreadsAfter: 'never',
    }),
  });
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'task');
    await settledProject(harness, project.id);
    await sweepAfter(t, harness, 31 * dayMs);
    await sweepAfter(t, harness, 10_000);
    assert.equal(await isArchived(harness, main.id), false);
  } finally {
    await harness.dispose();
  }
});

void test('T-12 an unread result keeps a main thread until a view ends after it', {
  timeout: 30_000,
}, async (t) => {
  const { harness, project, main } = await family(t, {
    configuration: configured({ agentThreads: false }),
  });
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'task');
    const first = await settledTurn(harness, main.id);
    (await viewOf(harness, main.id)).dispose();
    t.mock.timers.tick(1);
    await harness.service.threads.prompt(main.id, 'task');
    const unread = await settledTurn(harness, main.id, first.result?.promptId);

    await sweepAfter(t, harness, 7 * dayMs + 10_000);
    assert.equal(await isArchived(harness, main.id), false);

    t.mock.timers.tick(1);
    (await viewOf(harness, main.id)).dispose();
    await harness.waitFor(async () => {
      const state = (
        await harness.stores.threads.archiveStates(project.id)
      ).find((entry) => entry.thread.id === main.id);
      return (
        state?.viewedAt !== undefined &&
        Date.parse(state.viewedAt) > Date.parse(unread.result?.at ?? '')
      );
    }, 'the view end to be written');
    await sweepAfter(t, harness, 10_000);
    await archivedSoon(harness, main.id);
  } finally {
    await harness.dispose();
  }
});

void test('T-12 a main thread restored with no turn ended since is never archived by the main-thread rule (D6)', {
  timeout: 30_000,
}, async (t) => {
  const { harness, project, main } = await family(t, {
    configuration: configured({ agentThreads: false }),
  });
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'task');
    const first = await settledTurn(harness, main.id);
    assert.equal(
      (await harness.service.threads.archive(main.id)).status,
      'archived',
    );
    assert.equal(
      (await harness.service.threads.restore(main.id)).status,
      'restored',
    );

    await sweepAfter(t, harness, 31 * dayMs);
    await sweepAfter(t, harness, 10_000);
    assert.equal(await isArchived(harness, main.id), false);

    // A turn that ends after the restore lifts it.
    t.mock.timers.tick(1);
    await harness.service.threads.prompt(main.id, 'task');
    await settledTurn(harness, main.id, first.result?.promptId);
    await settledProject(harness, project.id);
    await sweepAfter(t, harness, 7 * dayMs + 10_000);
    await archivedSoon(harness, main.id);
  } finally {
    await harness.dispose();
  }
});

void test('T-13 a new service sweeps a Project only 30 s after it first sees it live', {
  timeout: 30_000,
}, async (t) => {
  const backend = memoryBackend();
  const {
    harness: first,
    script,
    project,
    main,
  } = await family(t, {
    backend,
  });
  let second: Harness | undefined;
  try {
    await first.service.threads.prompt(main.id, 'spawn');
    await first.waitFor(() => script.children.length === 1, 'the spawn');
    const [child] = script.children as [string];
    await settledProject(first, project.id);
    await first.dispose();

    second = createHarness({ backend, execute: script.execute });
    // A prompt brings the Project back to life in the new process.
    await second.service.threads.prompt(main.id, 'task');
    await settledProject(second, project.id);
    await second.sweep();
    await sweepAfter(t, second, projectGraceMs - 1);
    assert.equal(await isArchived(second, child), false);
    await sweepAfter(t, second, 1);
    await archivedSoon(second, child);
  } finally {
    await second?.dispose();
    await backend.close();
  }
});

void test('T-17 a restored child is not archived again until a turn ends after the restore', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('task');
    const first = await settledTurn(harness, child);
    assert.equal(
      (await harness.service.threads.archive(child)).status,
      'archived',
    );
    assert.equal(
      (await harness.service.threads.restore(child)).status,
      'restored',
    );

    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    t.mock.timers.tick(1);
    assert.equal((await controls.send(child, 'task')).status, 'accepted');
    await settledTurn(harness, child, first.result?.promptId);
    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-31 the reader’s stop blocks both rules', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, project, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child, promptId } = await controls.spawn('gated');
    await harness.waitFor(() => script.waiting() === 1, 'the child to run');
    assert.equal(
      await harness.service.threads.interrupt(child, promptId),
      'interrupted',
    );
    await settledTurn(harness, child);
    await harness.service.threads.resumeQueue(child);
    const state = (await harness.stores.threads.archiveStates(project.id)).find(
      (entry) => entry.thread.id === child,
    );
    assert.equal(state?.interrupted, true);
    assert.equal(state?.thread.result?.status, 'cancelled');

    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    script.release();
    await settledProject(harness, project.id);
    await sweepAfter(t, harness, 7 * dayMs + 10_000);
    assert.equal(await isArchived(harness, main.id), false);
    assert.equal(await isArchived(harness, child), false);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-31 a parent’s stop and a termination leave a cancelled result that is archived by 40 s', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, project, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const stopped = await controls.spawn('gated');
    const terminated = await controls.spawn('gated');
    await harness.waitFor(() => script.waiting() === 2, 'both children');
    assert.equal(
      await controls.interrupt(stopped.threadId, stopped.promptId),
      'interrupted',
    );
    await controls.terminate(terminated.threadId);
    for (const id of [stopped.threadId, terminated.threadId]) {
      const record = await settledTurn(harness, id);
      assert.equal(record.result?.status, 'cancelled', id);
    }
    const states = await harness.stores.threads.archiveStates(project.id);
    for (const id of [stopped.threadId, terminated.threadId])
      assert.equal(
        states.find((entry) => entry.thread.id === id)?.interrupted,
        false,
        id,
      );

    await sweepAfter(t, harness, finishedDelayMs - 1);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, stopped.threadId);
    await archivedSoon(harness, terminated.threadId);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-32 a question form keeps a child until a turn without one', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    const controls = await holding(harness, script, main.id);
    const { threadId: child } = await controls.spawn('question');
    const asked = await settledTurn(harness, child);
    await sweepAfter(t, harness, 60_000);
    assert.equal(await isArchived(harness, child), false);

    assert.equal((await controls.send(child, 'task')).status, 'accepted');
    await settledTurn(harness, child, asked.result?.promptId);
    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    script.release();
    await harness.dispose();
  }
});

void test('T-32 a child’s open question keeps its main thread from the main-thread rule', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, project, main } = await family(t);
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'spawn-question');
    await harness.waitFor(() => script.children.length === 1, 'the spawn');
    const [child] = script.children as [string];
    await settledProject(harness, project.id);
    await sweepAfter(t, harness, 7 * dayMs + 10_000);
    await sweepAfter(t, harness, 10_000);
    assert.equal(await isArchived(harness, main.id), false);
    assert.equal(await isArchived(harness, child), false);
  } finally {
    await harness.dispose();
  }
});

void test('T-40 a parent archived by hand while its child runs is un-archived before it takes the child’s result', {
  timeout: 30_000,
}, async (t) => {
  const { harness, script, main } = await family(t);
  try {
    await goLive(t, harness);
    await harness.service.threads.prompt(main.id, 'spawn-gated');
    await harness.waitFor(() => script.waiting() === 1, 'the child to run');
    const [child] = script.children as [string];
    const spawnedTurn = await settledTurn(harness, main.id);

    const archived = await harness.service.threads.archive(main.id);
    assert.equal(archived.status, 'archived');
    assert.deepEqual(
      archived.status === 'archived'
        ? archived.threads.map((thread) => thread.id)
        : [],
      [main.id],
    );
    assert.equal(await isArchived(harness, child), false);

    const from = harness.notices.length;
    script.open();
    await settledTurn(harness, child);
    await settledTurn(harness, main.id, spawnedTurn.result?.promptId);
    unarchivedBeforeStart(harness, from, main.id);

    await sweepAfter(t, harness, finishedDelayMs - 1);
    assert.equal(await isArchived(harness, child), false);
    await sweepAfter(t, harness, 10_001);
    await archivedSoon(harness, child);
  } finally {
    await harness.dispose();
  }
});
