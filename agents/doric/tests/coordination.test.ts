import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadControl } from 'host';

import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { Thread, WorkspaceService } from '../src/lib/workspace/types.js';
import { deferred, pool, workspace } from './helpers/workspace.js';

const create = async (
  service: WorkspaceService,
  projectId: string,
  parentId?: string,
): Promise<Thread> => {
  const value = await service.threads.create(projectId, 'Thread', parentId);
  assert.ok(value.status === 'created');
  return value.thread;
};

test(
  'allows bound parent controls to interrupt and terminate child work',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const bound = deferred<ThreadControl>();
    const parentFinish = deferred();
    const started = deferred();
    const settle = deferred();
    const next = deferred();
    const nextFinish = deferred();
    const descendantStarted = deferred();
    const descendantFinish = deferred();
    let activeSignal: AbortSignal | undefined;
    let descendantSignal: AbortSignal | undefined;
    let nextSignal: AbortSignal | undefined;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job, host, signal }) => {
        if (job.prompt === 'parent') {
          bound.resolve(host.threads);
          await parentFinish.promise;
        } else if (job.prompt === 'child') {
          activeSignal = signal;
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
    const project = await service.projects.create('Project');
    const parent = await create(service, project.id);
    const child = await create(service, project.id, parent.id);
    const descendant = await create(service, project.id, child.id);
    await service.threads.prompt(parent.id, 'parent');
    const control = await bound.promise;
    const request = await control.send(child.id, 'child');
    assert.ok(request.status === 'accepted');
    await started.promise;
    assert.equal((await control.send(child.id, 'next')).status, 'accepted');
    await service.threads.prompt(descendant.id, 'descendant');
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
    await harness.threadState(descendant.id, 'cancelled');
    assert.equal((await service.projects.find(project.id))?.state, 'ready');
    assert.equal((await service.threads.find(parent.id))?.state, 'running');
    parentFinish.resolve();
    await service.dispose();
  },
);

test(
  'binds coordination to direct children and to the lifetime of the calling prompt',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    const finish = deferred();
    let control!: ThreadControl;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ host }) => {
        control = host.threads;
        started.resolve();
        await finish.promise;
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    const otherProject = await service.projects.create('Other project');
    const parent = await create(service, project.id);
    const child = await create(service, project.id, parent.id);
    const grandchild = await create(service, project.id, child.id);
    const sibling = await create(service, project.id);
    const foreign = await create(service, otherProject.id);
    const prompt = await service.threads.prompt(parent.id, 'coordinate');
    assert.ok(prompt.status === 'accepted');
    await started.promise;
    assert.equal((await control.get(child.id, 0)).thread.id, child.id);
    assert.deepEqual(
      (await control.list(100)).items.map(({ id }) => id),
      [child.id],
    );
    for (const id of [parent.id, sibling.id, grandchild.id, foreign.id]) {
      await assert.rejects(control.get(id, 0));
      await assert.rejects(control.send(id, 'forged access'));
      await assert.rejects(control.interrupt(id, prompt.promptId));
      await assert.rejects(control.terminate(id));
    }
    await service.threads.interrupt(parent.id, prompt.promptId);
    await assert.rejects(control.spawn('late task'));
    await assert.rejects(control.send(child.id, 'late task'));
    finish.resolve();
    await service.dispose();
  },
);

test(
  'redacts credentials before delivering delegated output to another Agent',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const result = deferred();
    let delivered = '';
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job, host }) => {
        if (job.source.kind === 'parent')
          return 'Evidence contains secret-value.';
        if (job.source.kind === 'result') {
          delivered = job.prompt;
          result.resolve();
          return 'done';
        }
        await host.threads.spawn('inspect');
        return 'delegated';
      },
    });
    const project = await service.projects.create('Project');
    const parent = await create(service, project.id);
    await service.threads.prompt(parent.id, 'delegate');
    await result.promise;
    assert.doesNotMatch(delivered, /secret-value/u);
    assert.match(delivered, /REDACTED/u);
    await service.dispose();
  },
);

test(
  'releases a late acquired lease after a queued Project is terminated',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const acquired = deferred();
    let released = 0;
    let executions = 0;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          await acquired.promise;
          return {
            sandbox: { id: 'late' },
            release: async () => {
              released += 1;
            },
          };
        },
      } as never,
      execute: async () => {
        executions += 1;
        return 'unexpected execution';
      },
    });
    const project = await service.projects.create('Project');
    const thread = await create(service, project.id);
    await service.threads.prompt(thread.id, 'queued');
    await service.projects.terminate(project.id);
    acquired.resolve();
    await service.dispose();
    assert.equal(released, 1);
    assert.equal(executions, 0);
    assert.equal((await service.threads.find(thread.id))?.state, 'cancelled');
  },
);
