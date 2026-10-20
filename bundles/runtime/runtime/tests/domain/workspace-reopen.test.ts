import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeThreads } from '../../src/contracts/threads.js';
import type { WorkspaceService } from '../../src/host/domain/types.js';
import {
  createHarness,
  deferred,
  type Harness,
  spawner,
} from './support/harness.js';

/*
 * The delegation surface's `restart` (runtime.threads/v1 1.4.0): a parent
 * prompt reopens a direct child whose *record* is `failed` in place — same id,
 * same history, same parent — and queues a prompt in it again: the one it is
 * given, or the child's own last accepted prompt. A child whose *prompt* failed
 * but whose Thread is healthy is continued with `thread-send`; a cancelled
 * child is irreversible.
 */

type ThreadControl = RuntimeThreads;

/**
 * Makes the child's record terminal `failed` the way the runtime does when a
 * terminal result can never be delivered: `close(..., 'terminal_result_failed')`
 * under the Project lock. Unlike a failed *prompt*, which leaves the Thread
 * `ready`, this is the Thread failure `restart` reopens.
 */
const failTerminal = async (
  service: WorkspaceService,
  harness: Harness,
  childId: string,
) => {
  await service.threads.failTerminalResult(childId);
  await harness.threadState(childId, 'failed');
};

void test('reopens a failed direct child in place and resends its last prompt', {
  timeout: 15_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  /** Every prompt the executor received, in order. */
  const received: string[] = [];
  let failures = 0;
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
        return 'parent done';
      }
      received.push(job.prompt);
      // The child's first run fails; the resent prompt runs to completion.
      if (job.prompt === 'work' && failures === 0) {
        failures += 1;
        throw new Error('provider exploded');
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;

  assert.equal((await control.send(child.id, 'work')).status, 'accepted');
  await harness.waitFor(() => failures === 1, 'the child prompt to fail');
  // A failed prompt leaves the Thread healthy.
  await harness.threadState(child.id, 'ready');
  await failTerminal(service, harness, child.id);
  assert.equal(
    (await service.threads.find(child.id))?.errorCode,
    'terminal_result_failed',
  );

  // The close that failed the record is still settling: restart must await
  // the Thread's ending task outside the Project lock, or this call hangs.
  const restarted = await control.restart(child.id);
  if (restarted.status !== 'accepted')
    assert.fail(`restart answered ${restarted.status}`);
  assert.equal(typeof restarted.promptId, 'string');
  await harness.waitFor(
    () => received.filter((prompt) => prompt === 'work').length === 2,
    'the child to receive its last prompt again',
  );
  await harness.waitFor(async () => {
    const record = await service.threads.find(child.id);
    return (
      record?.state === 'ready' &&
      record.errorCode === undefined &&
      record.finishedAt === undefined
    );
  }, 'the reopened child to settle healthy');

  const record = await service.threads.find(child.id);
  assert.notEqual(record?.state, 'failed');
  assert.equal(record?.errorCode, undefined);
  assert.equal(record?.finishedAt, undefined);
  parentFinish.resolve();
  await harness.dispose();
});

void test('refuses a healthy child and leaves thread-send as its continuation', {
  timeout: 10_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  let failures = 0;
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
        return 'parent done';
      }
      if (job.prompt === 'fail' && failures === 0) {
        failures += 1;
        throw new Error('provider exploded');
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;

  assert.deepEqual(await control.restart(child.id, 'x'), {
    status: 'not_failed',
  });
  assert.equal((await control.send(child.id, 'fail')).status, 'accepted');
  await harness.waitFor(() => failures === 1, 'the child prompt to fail');
  await harness.threadState(child.id, 'ready');

  // The prompt failed, not the Thread: nothing to reopen, and the child
  // takes new work through thread-send exactly as before.
  assert.deepEqual(await control.restart(child.id), {
    status: 'not_failed',
  });
  assert.equal((await control.send(child.id, 'follow-up')).status, 'accepted');
  parentFinish.resolve();
  await harness.dispose();
});

void test('never revives a cancelled child', { timeout: 10_000 }, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;

  await control.terminate(child.id);
  await harness.threadState(child.id, 'cancelled');
  assert.deepEqual(await control.restart(child.id), { status: 'terminated' });
  assert.equal((await service.threads.find(child.id))?.state, 'cancelled');
  parentFinish.resolve();
  await harness.dispose();
});

void test('answers no_prompt for a failed child with nothing to resend', {
  timeout: 10_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  // A Thread that was never prompt has no accepted prompt in its log.
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;

  assert.ok(
    await harness.stores.threads.setState(
      child.id,
      'failed',
      undefined,
      'persistence_failed',
    ),
  );
  // The failure was written past the runner's snapshot: restart reads the
  // stored record, not the in-memory Thread.
  assert.deepEqual(await control.restart(child.id), { status: 'no_prompt' });
  assert.equal((await service.threads.find(child.id))?.state, 'failed');
  parentFinish.resolve();
  await harness.dispose();
});

void test('answers inactive for a child of a terminated Project', {
  timeout: 15_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;
  await failTerminal(service, harness, child.id);

  await service.projects.terminate(project.id);
  assert.deepEqual(await control.restart(child.id), { status: 'inactive' });
  parentFinish.resolve();
  await harness.dispose();
});

void test('restarts only the direct children of the calling prompt', {
  timeout: 10_000,
}, async () => {
  const started = deferred();
  const finish = deferred();
  const tree = spawner();
  let control!: ThreadControl;
  const harness = createHarness({
    execute: async (run) => {
      if (run.job.prompt !== 'coordinate') return tree.execute(run);
      control = run.tools.threads;
      started.resolve();
      await finish.promise;
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const other = await service.projects.create('Other project');
  await harness.projectState(other.id, 'ready');
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  const sibling = await harness.createThread(project.id);
  // The grandchild is the agent Thread the child spawns: the parent cannot
  // reach past its own children.
  assert.equal(
    (await service.threads.prompt(child.id, 'spawn')).status,
    'accepted',
  );
  const grandchild = await tree.spawned(child.id);
  const foreign = await harness.createThread(other.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'coordinate')).status,
    'accepted',
  );
  await started.promise;

  for (const id of [parent.id, sibling.id, grandchild, foreign.id]) {
    await assert.rejects(control.restart(id), {
      message: 'Thread is not a direct child.',
    });
  }
  finish.resolve();
  await harness.dispose();
});

void test('restart dies with the prompt that started it', {
  timeout: 10_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  const running = await service.threads.prompt(parent.id, 'parent');
  assert.ok(running.status === 'accepted');
  const control = await bound.promise;
  await failTerminal(service, harness, child.id);

  await service.threads.interrupt(parent.id, running.promptId);
  await assert.rejects(control.restart(child.id), {
    message: 'Thread control is no longer active.',
  });
  parentFinish.resolve();
  await harness.dispose();
});

void test('refuses a blank prompt at the runtime boundary', {
  timeout: 10_000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
  assert.equal(
    (await service.threads.prompt(parent.id, 'parent')).status,
    'accepted',
  );
  const control = await bound.promise;
  await failTerminal(service, harness, child.id);

  await assert.rejects(control.restart(child.id, '   '), {
    name: 'TypeError',
    message: 'A non-empty prompt is required.',
  });
  assert.equal((await service.threads.find(child.id))?.state, 'failed');
  parentFinish.resolve();
  await harness.dispose();
});
