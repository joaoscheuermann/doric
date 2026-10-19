import assert from 'node:assert/strict';
import test from 'node:test';

import type { Thread } from '../../src/contracts/model.js';
import type { RuntimeThreads } from '../../src/contracts/threads.js';
import type { WorkspaceService } from '../../src/host/domain/types.js';
import { createHarness, deferred, spawner } from './support/harness.js';

/*
 * Ported from agents/doric tests/coordination.test.ts (design 57 §13.1,
 * stage 5 "Delegation"): the parent controls are `runtime.threads/v1` called
 * with the parent prompt's scope, as the delegation tools call it.
 */

type ThreadControl = RuntimeThreads;

const create = async (
  service: WorkspaceService,
  projectId: string,
  parentId?: string,
): Promise<Thread> => {
  const value = await service.threads.create(projectId, 'Thread', parentId);
  assert.ok(value.status === 'created');
  return value.thread;
};

void test('allows bound parent controls to interrupt and terminate child work', {
  timeout: 5000,
}, async () => {
  const bound = deferred<ThreadControl>();
  const parentFinish = deferred();
  const started = deferred();
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const settle = deferred();
  const next = deferred();
  const nextFinish = deferred();
  const descendantStarted = deferred();
  const descendantFinish = deferred();
  let activeSignal: AbortSignal | undefined;
  let descendantSignal: AbortSignal | undefined;
  let nextSignal: AbortSignal | undefined;
  const harness = createHarness({
    execute: async ({ job, tools, signal }) => {
      if (job.prompt === 'parent') {
        bound.resolve(tools.threads);
        await parentFinish.promise;
      } else if (job.prompt === 'child') {
        activeSignal = signal;
        // The descendant hangs off the Thread whose agent spawned it: the reader
        // branches a main Thread into a sub-thread, and only an agent nests
        // deeper than that.
        spawned.resolve(await tools.threads.spawn('descendant'));
        started.resolve();
        await settle.promise;
      } else if (job.prompt === 'descendant') {
        descendantSignal = signal;
        descendantStarted.resolve();
        await descendantFinish.promise;
      } else if (job.prompt === 'next') {
        nextSignal = signal;
        next.resolve();
        await nextFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const parent = await create(service, project.id);
  const child = await create(service, project.id, parent.id);
  await service.threads.prompt(parent.id, 'parent');
  const control = await bound.promise;
  const request = await control.send(child.id, 'child');
  assert.ok(request.status === 'accepted');
  await started.promise;
  const descendant = await spawned.promise;
  assert.equal((await control.send(child.id, 'next')).status, 'accepted');
  await descendantStarted.promise;
  assert.equal(
    await control.interrupt(child.id, request.promptId),
    'interrupted',
  );
  assert.equal(activeSignal?.aborted, true);
  assert.equal(descendantSignal?.aborted, false);
  assert.equal(nextSignal, undefined);
  settle.resolve();
  await next.promise;
  assert.equal((nextSignal as AbortSignal | undefined)?.aborted, false);
  await control.terminate(child.id);
  assert.equal((nextSignal as AbortSignal | undefined)?.aborted, true);
  assert.equal(descendantSignal?.aborted, true);
  nextFinish.resolve();
  descendantFinish.resolve();
  await harness.threadState(child.id, 'cancelled');
  await harness.threadState(descendant.threadId, 'cancelled');
  assert.equal((await service.projects.find(project.id))?.state, 'ready');
  assert.equal((await service.threads.find(parent.id))?.state, 'running');
  parentFinish.resolve();
  await harness.dispose();
});

void test('binds coordination to direct children and to the lifetime of the calling prompt', {
  timeout: 5000,
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
  const project = await service.projects.create('Project');
  const otherProject = await service.projects.create('Other project');
  const parent = await create(service, project.id);
  const child = await create(service, project.id, parent.id);
  // The grandchild is an agent Thread the child spawns: the reader cannot open a
  // sub-thread under a sub-thread, and the parent cannot reach past its own.
  assert.equal(
    (await service.threads.prompt(child.id, 'spawn')).status,
    'accepted',
  );
  const grandchild = await tree.spawned(child.id);
  const sibling = await create(service, project.id);
  const foreign = await create(service, otherProject.id);
  const prompt = await service.threads.prompt(parent.id, 'coordinate');
  assert.ok(prompt.status === 'accepted');
  await started.promise;
  assert.equal((await control.get(child.id)).thread.id, child.id);
  assert.deepEqual(
    (await control.list(100)).items.map(({ id }) => id),
    [child.id],
  );
  for (const id of [parent.id, sibling.id, grandchild, foreign.id]) {
    await assert.rejects(control.get(id));
    await assert.rejects(control.send(id, 'forged access'));
    await assert.rejects(control.interrupt(id, prompt.promptId));
    await assert.rejects(control.terminate(id));
  }
  await service.threads.interrupt(parent.id, prompt.promptId);
  await assert.rejects(control.spawn('late task'));
  await assert.rejects(control.send(child.id, 'late task'));
  finish.resolve();
  await harness.dispose();
});

void test('redacts credentials before delivering delegated output to another Agent', {
  timeout: 5000,
}, async () => {
  const result = deferred();
  let delivered = '';
  const harness = createHarness({
    credentials: () => [
      { id: 'c1', kind: 'API_TOKEN', name: 'Key', secret: 'secret-value' },
    ],
    execute: async ({ job, tools }) => {
      if (job.source.kind === 'parent')
        return 'Evidence contains secret-value.';
      if (job.source.kind === 'result') {
        delivered = job.prompt;
        result.resolve();
        return 'done';
      }
      await tools.threads.spawn('inspect');
      return 'delegated';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const parent = await create(service, project.id);
  await service.threads.prompt(parent.id, 'delegate');
  await result.promise;
  assert.doesNotMatch(delivered, /secret-value/u);
  assert.match(delivered, /REDACTED/u);
  await harness.dispose();
});

void test('releases a late acquired lease after a queued Project is terminated', {
  timeout: 5000,
}, async () => {
  const acquired = deferred();
  let released = 0;
  let executions = 0;
  const harness = createHarness({
    sandbox: {
      acquire: async () => {
        await acquired.promise;
        return {
          sandbox: { id: 'late' },
          release: async () => {
            released += 1;
          },
        } as never;
      },
    },
    execute: async () => {
      executions += 1;
      return 'unexpected execution';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const thread = await create(service, project.id);
  await service.threads.prompt(thread.id, 'queued');
  await service.projects.terminate(project.id);
  acquired.resolve();
  await service.dispose();
  assert.equal(released, 1);
  assert.equal(executions, 0);
  assert.equal((await service.threads.find(thread.id))?.state, 'cancelled');
  await harness.dispose();
});
