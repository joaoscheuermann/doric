import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { Thread } from '../../../src/contracts/model.js';
import type { RuntimeThreads } from '../../../src/contracts/threads.js';
import { projectGraceMs } from '../../../src/host/domain/archiver.js';
import {
  createHarness,
  deferred,
  type Harness,
  type HarnessOptions,
  type HarnessRun,
} from './harness.js';

/*
 * Shared setup of the thread-archive cases (docs/designs/thread-archive.md,
 * T-6 … T-40): a scripted agent that spawns, holds, fails, asks or waits on
 * cue, and the waits and observations the cases repeat. `Date` is mocked by
 * the cases that sweep (D28); the sweep is run by hand through the harness.
 */

export const base = Date.parse('2026-11-17T12:00:00.000Z');
export const second = 1000;
export const dayMs = 86_400_000;

/** A turn's text that ends with a question form (§2.1). */
export const questionText =
  'Which one?\n\n```openui-lang\nroot = AskForm([q1])\nq1 = Question("Pick", ["a", "b"])\n```';

/**
 * The prompts the scripted agent knows:
 * - `hold`: binds the Thread's child controls and runs until `release`;
 * - `spawn`, `spawn-question`, `spawn-gated`: spawns a child prompted
 *   `task`, `question` or `gated` and finishes;
 * - `question`: answers with a question form;
 * - `fail`: fails the turn;
 * - `gated`: runs until `open()` or until aborted;
 * - anything else (`task`, a delivered result): answers `done`.
 */
export const scripted = () => {
  const controls = deferred<RuntimeThreads>();
  const release = deferred();
  const gates: (() => void)[] = [];
  const children: string[] = [];
  const spawnedPrompts: string[] = [];
  const execute = async ({ job, tools, signal }: HarnessRun) => {
    switch (job.prompt) {
      case 'hold':
        controls.resolve(tools.threads);
        await Promise.race([
          release.promise,
          new Promise<void>((done) =>
            signal?.addEventListener('abort', () => done(), { once: true }),
          ),
        ]);
        signal?.throwIfAborted();
        return 'parent done';
      case 'spawn':
      case 'spawn-question':
      case 'spawn-gated': {
        const prompt =
          job.prompt === 'spawn' ? 'task' : job.prompt.slice('spawn-'.length);
        const { threadId, promptId } = await tools.threads.spawn(prompt);
        children.push(threadId);
        spawnedPrompts.push(promptId);
        return 'spawned';
      }
      case 'question':
        return questionText;
      case 'fail':
        throw new Error('provider exploded');
      case 'gated':
        await new Promise<void>((done) => {
          gates.push(done);
          signal?.addEventListener('abort', () => done(), { once: true });
        });
        signal?.throwIfAborted();
        return 'done';
      default:
        return 'done';
    }
  };
  return {
    execute,
    /** The controls of the Thread prompted `hold`. */
    controls: controls.promise,
    release: () => release.resolve(),
    children,
    spawnedPrompts,
    /** How many `gated` runs wait. */
    waiting: () => gates.length,
    /** Lets the oldest `gated` run finish. */
    open: () => gates.shift()?.(),
  };
};

export type Script = ReturnType<typeof scripted>;

export const recordOf = async (harness: Harness, id: string) => {
  const record = await harness.stores.threads.record(id);
  assert.ok(record, `Thread ${id} exists`);
  return record;
};

/** Waits until the Thread runs nothing and has a result other than `after`'s. */
export const settledTurn = async (
  harness: Harness,
  id: string,
  after?: string,
): Promise<Thread> => {
  await harness.waitFor(async () => {
    const record = await harness.stores.threads.record(id);
    return (
      record !== undefined &&
      record.state !== 'running' &&
      record.state !== 'queued' &&
      record.state !== 'cancelling' &&
      record.activePromptId === undefined &&
      record.result !== undefined &&
      record.result.promptId !== after
    );
  }, `a settled turn of ${id}`);
  return recordOf(harness, id);
};

/** Waits until the Thread runs nothing and queues nothing. */
export const idleThread = (harness: Harness, id: string) =>
  harness.waitFor(async () => {
    const record = await harness.stores.threads.record(id);
    const queue = await harness.service.threads.queue(id);
    return (
      record?.state === 'ready' &&
      record.activePromptId === undefined &&
      (queue?.items.length ?? 0) === 0
    );
  }, `${id} to be idle`);

/** Waits until every Thread of the Project runs nothing and has a result. */
export const settledProject = async (harness: Harness, projectId: string) =>
  harness.waitFor(async () => {
    const threads = await harness.stores.threads.listByProject(projectId);
    const queues = await Promise.all(
      threads.map((thread) => harness.service.threads.queue(thread.id)),
    );
    return threads.every(
      (thread, index) =>
        thread.state === 'ready' &&
        thread.activePromptId === undefined &&
        thread.result !== undefined &&
        (queues[index]?.items.length ?? 0) === 0,
    );
  }, `Project ${projectId} to settle`);

export const isArchived = async (harness: Harness, id: string) =>
  (await recordOf(harness, id)).archivedAt !== undefined;

/** Whether a published record of `id` carried `archivedAt`. */
export const publishedArchived = (harness: Harness, id: string) =>
  harness.notices.some(
    (notice) =>
      notice.kind === 'threadUpdated' &&
      notice.value.id === id &&
      notice.value.archivedAt !== undefined,
  );

/** Waits until `id` is archived in storage and published so. */
export const archivedSoon = (harness: Harness, id: string) =>
  harness.waitFor(
    async () =>
      (await isArchived(harness, id)) && publishedArchived(harness, id),
    `${id} to be archived and published`,
  );

/**
 * Asserts that, among the notices from index `from`, a record of `id`
 * without `archivedAt` was published before its next `prompt.started`.
 */
export const unarchivedBeforeStart = (
  harness: Harness,
  from: number,
  id: string,
) => {
  const seen = harness.notices.slice(from);
  const published = seen.findIndex(
    (notice) =>
      notice.kind === 'threadUpdated' &&
      notice.value.id === id &&
      notice.value.archivedAt === undefined,
  );
  const started = seen.findIndex(
    (notice) =>
      notice.kind === 'event' &&
      notice.value.threadId === id &&
      notice.value.type === 'prompt.started',
  );
  assert.ok(published >= 0, `${id} was published without archivedAt`);
  assert.ok(started >= 0, `${id} started a prompt`);
  assert.ok(published < started, `${id} was un-archived before it ran`);
};

/** A harness on mocked `Date` whose sweeps the case runs by hand. */
export const archiveHarness = (
  t: TestContext,
  options: HarnessOptions = {},
) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const script = scripted();
  const harness = createHarness({ execute: script.execute, ...options });
  return { harness, script };
};

/**
 * Makes the harness's live Projects old enough to sweep: one sweep sees them
 * now, then 30 s pass (D29).
 */
export const goLive = async (t: TestContext, harness: Harness) => {
  await harness.sweep();
  t.mock.timers.tick(projectGraceMs);
};

/** Advances `Date` by `ms`, then runs one sweep. */
export const sweepAfter = async (
  t: TestContext,
  harness: Harness,
  ms: number,
) => {
  t.mock.timers.tick(ms);
  await harness.sweep();
};
