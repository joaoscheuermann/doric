import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type {
  InputSource,
  Project,
  Thread,
  WorkspaceService,
} from '../src/lib/workspace/types.js';
import { deferred, pool, sandbox, workspace } from './helpers/workspace.js';

const createThread = async (
  service: WorkspaceService,
  projectId: string,
  parentId?: string,
) => {
  const result = await service.threads.create(projectId, 'Thread', parentId);
  assert.equal(result.status, 'created');
  if (result.status !== 'created') throw new Error('Thread creation failed');
  return result.thread;
};

test('creates, lists, and renames named Projects and Threads', async () => {
  const harness = workspace();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Initial project');
  const thread = await createThread(service, project.id);
  assert.equal(project.name, 'Initial project');
  assert.equal(thread.name, 'Thread');
  assert.equal(
    (await service.projects.rename(project.id, 'Renamed project'))?.name,
    'Renamed project',
  );
  assert.equal(
    (await service.threads.rename(thread.id, 'Renamed thread'))?.name,
    'Renamed thread',
  );
  assert.equal(
    (await service.projects.list(10)).items[0]?.name,
    'Renamed project',
  );
  assert.equal(
    (await service.threads.list(project.id, 10))?.items[0]?.name,
    'Renamed thread',
  );
  assert.equal(
    await service.projects.rename(randomUUID(), 'Missing'),
    undefined,
  );
  assert.equal(
    await service.threads.rename(randomUUID(), 'Missing'),
    undefined,
  );
  await service.dispose();
});

test('serializes Project rename with terminal state publication', async () => {
  const harness = workspace();
  const stateCaptured = deferred();
  const releaseState = deferred();
  const updates: Project[] = [];
  const setState = harness.projects.setState;
  harness.projects.setState = async (...args) => {
    const value = await setState(...args);
    if (args[1] === 'cancelled') {
      stateCaptured.resolve();
      await releaseState.promise;
    }
    return value;
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    publisher: {
      ...harness.publisher,
      projectUpdated: (value) => {
        updates.push(value);
        harness.publisher.projectUpdated(value);
      },
    },
    pool: pool(),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Initial');
  await harness.projectState(project.id, 'ready');
  await service.projects.terminate(project.id);
  await stateCaptured.promise;
  let renameSettled = false;
  const rename = service.projects.rename(project.id, 'Renamed').finally(() => {
    renameSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renameSettled, false);
  releaseState.resolve();
  assert.equal((await rename)?.name, 'Renamed');
  await service.dispose();
  assert.equal(updates.at(-1)?.name, 'Renamed');
  assert.equal((await service.projects.find(project.id))?.name, 'Renamed');
});

test('serializes Thread rename with terminal state publication', async () => {
  const harness = workspace();
  const stateCaptured = deferred();
  const releaseState = deferred();
  const updates: Thread[] = [];
  const setState = harness.threads.setState;
  harness.threads.setState = async (...args) => {
    const value = await setState(...args);
    if (args[1] === 'cancelled') {
      stateCaptured.resolve();
      await releaseState.promise;
    }
    return value;
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    publisher: {
      ...harness.publisher,
      threadUpdated: (value) => {
        updates.push(value);
        harness.publisher.threadUpdated(value);
      },
    },
    pool: pool(),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  await service.threads.terminate(thread.id);
  await stateCaptured.promise;
  let renameSettled = false;
  const rename = service.threads.rename(thread.id, 'Renamed').finally(() => {
    renameSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renameSettled, false);
  releaseState.resolve();
  assert.equal((await rename)?.name, 'Renamed');
  assert.equal(updates.at(-1)?.name, 'Renamed');
  assert.equal((await service.threads.find(thread.id))?.name, 'Renamed');
  await service.dispose();
});

test('derives delegated Thread names without splitting Unicode characters', async () => {
  const harness = workspace();
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const prompt = '😀'.repeat(81);
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(),
    execute: async ({ job, coordination }) => {
      if (job.prompt === 'coordinate')
        spawned.resolve(await coordination.spawn(prompt));
      return 'done';
    },
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const parent = await createThread(service, project.id);
  await service.threads.prompt(parent.id, 'coordinate');
  const child = await spawned.promise;
  assert.equal(
    (await service.threads.find(child.threadId))?.name,
    '😀'.repeat(80),
  );
  await service.dispose();
});

test(
  'shares one Project lease while Threads run independently and each preserves FIFO',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const firstStarted = deferred();
    const otherStarted = deferred();
    const secondStarted = deferred();
    const thirdStarted = deferred();
    const finishFirst = deferred();
    const finishOther = deferred();
    const calls: string[] = [];
    let acquisitions = 0;
    const sandboxes: string[] = [];
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          acquisitions += 1;
          return { sandbox, release: async () => undefined };
        },
      } as never,
      execute: async ({ job, sandbox: environment }) => {
        calls.push(job.prompt);
        sandboxes.push(environment.id);
        if (job.prompt === 'first') {
          firstStarted.resolve();
          await finishFirst.promise;
        } else if (job.prompt === 'other') {
          otherStarted.resolve();
          await finishOther.promise;
        } else if (job.prompt === 'second') secondStarted.resolve();
        else thirdStarted.resolve();
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const first = await createThread(service, project.id);
    const other = await createThread(service, project.id);
    await service.threads.prompt(first.id, 'first');
    await firstStarted.promise;
    await service.threads.prompt(first.id, 'second');
    await service.threads.prompt(first.id, 'third');
    await service.threads.prompt(other.id, 'other');
    await otherStarted.promise;
    assert.deepEqual(calls, ['first', 'other']);
    finishFirst.resolve();
    await secondStarted.promise;
    await thirdStarted.promise;
    await harness.threadState(first.id, 'ready');
    assert.deepEqual(calls, ['first', 'other', 'second', 'third']);
    assert.deepEqual(sandboxes, ['vm-1', 'vm-1', 'vm-1', 'vm-1']);
    assert.equal(acquisitions, 1);
    finishOther.resolve();
    await service.dispose();
  },
);

test(
  'interrupts only the targeted prompt and leaves its queue and daughter running',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    const childStarted = deferred();
    const nextStarted = deferred();
    const finishNext = deferred();
    const finishChild = deferred();
    const interrupted = deferred();
    const finishInterrupted = deferred();
    let nextSignal: AbortSignal | undefined;
    let childSignal: AbortSignal | undefined;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job, signal }) => {
        if (job.prompt === 'first') {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          interrupted.resolve();
          await finishInterrupted.promise;
        } else if (job.prompt === 'child') {
          childSignal = signal;
          childStarted.resolve();
          await finishChild.promise;
        } else {
          nextSignal = signal;
          nextStarted.resolve();
          await finishNext.promise;
        }
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const parent = await createThread(service, project.id);
    const child = await createThread(service, project.id, parent.id);
    const prompt = await service.threads.prompt(parent.id, 'first');
    assert.ok(prompt.status === 'accepted');
    await started.promise;
    await service.threads.prompt(parent.id, 'next');
    await service.threads.prompt(child.id, 'child');
    await childStarted.promise;
    assert.equal(
      await service.threads.interrupt(parent.id, prompt.promptId),
      'interrupted',
    );
    await interrupted.promise;
    assert.equal(nextSignal, undefined);
    finishInterrupted.resolve();
    await nextStarted.promise;
    assert.equal(
      await service.threads.interrupt(parent.id, prompt.promptId),
      'not_running',
    );
    assert.equal((nextSignal as AbortSignal | undefined)?.aborted, false);
    assert.equal(childSignal?.aborted, false);
    finishNext.resolve();
    finishChild.resolve();
    await service.dispose();
  },
);

test(
  'terminates a subtree without terminating its sibling or Project',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async () => 'done',
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const root = await createThread(service, project.id);
    const child = await createThread(service, project.id, root.id);
    const grandchild = await createThread(service, project.id, child.id);
    const otherChild = await createThread(service, project.id, root.id);
    const otherGrandchild = await createThread(
      service,
      project.id,
      otherChild.id,
    );
    const sibling = await createThread(service, project.id);
    await service.threads.terminate(root.id);
    for (const thread of [
      root,
      child,
      grandchild,
      otherChild,
      otherGrandchild,
    ]) {
      await harness.threadState(thread.id, 'cancelled');
      assert.equal(
        (await service.threads.prompt(thread.id, 'later')).status,
        'inactive',
      );
      assert.notEqual(
        (await service.threads.create(project.id, 'Child', thread.id)).status,
        'created',
      );
    }
    assert.equal(
      (await service.threads.prompt(sibling.id, 'work')).status,
      'accepted',
    );
    assert.equal((await service.projects.find(project.id))?.state, 'ready');
    await service.dispose();
  },
);

test(
  'blocks creation during Project termination and releases once after execution stops',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    const aborted = deferred();
    const finish = deferred();
    let releases = 0;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(() => {
        releases += 1;
      }),
      execute: async ({ signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        started.resolve();
        await finish.promise;
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const thread = await createThread(service, project.id);
    await service.threads.prompt(thread.id, 'work');
    await started.promise;
    const pending = await service.threads.prompt(thread.id, 'queued');
    assert.ok(pending.status === 'accepted');
    await service.projects.terminate(project.id);
    await aborted.promise;
    assert.equal(releases, 0);
    assert.equal(
      (await service.threads.create(project.id, 'Thread')).status,
      'inactive',
    );
    assert.equal(
      (await service.threads.prompt(thread.id, 'later')).status,
      'inactive',
    );
    await service.projects.terminate(project.id);
    finish.resolve();
    await service.dispose();
    assert.equal(releases, 1);
    assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
    const history = await service.threads.events(thread.id, 0);
    assert.ok(
      history?.events.some(
        (event) =>
          event.promptId === pending.promptId &&
          event.type === 'agent.cancelled',
      ),
    );
  },
);

test(
  'keeps queued work usable after a prompt fails without exposing execution secrets',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const nextStarted = deferred();
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job }) => {
        if (job.prompt === 'broken') throw new Error('credential secret-value');
        nextStarted.resolve();
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const thread = await createThread(service, project.id);
    const failed = await service.threads.prompt(thread.id, 'broken');
    await service.threads.prompt(thread.id, 'next');
    await nextStarted.promise;
    assert.ok(failed.status === 'accepted');
    const events = await service.threads.events(thread.id, 0);
    assert.ok(
      events?.events.some(
        (event) =>
          event.promptId === failed.promptId && event.type === 'agent.failed',
      ),
    );
    assert.doesNotMatch(JSON.stringify(events), /secret-value/u);
    await service.dispose();
  },
);

test(
  'accepts many simultaneous Threads without imposing execution slots',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const allStarted = deferred();
    const finish = deferred();
    const count = 24;
    const running = new Set<string>();
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ thread }) => {
        running.add(thread.id);
        if (running.size === count) allStarted.resolve();
        await finish.promise;
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const threads = await Promise.all(
      Array.from({ length: count }, () => createThread(service, project.id)),
    );
    for (const thread of threads) {
      assert.equal(
        (await service.threads.prompt(thread.id, 'work')).status,
        'accepted',
      );
    }
    await allStarted.promise;
    assert.equal(running.size, count);
    finish.resolve();
    await service.dispose();
  },
);

test(
  'fails the Project when acquiring its sandbox fails',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          throw new Error('secret-value');
        },
      } as never,
      execute: async () => 'unused',
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'failed');
    assert.equal(
      (await service.projects.find(project.id))?.errorCode,
      'sandbox_acquisition_failed',
    );
    assert.equal(
      (await service.threads.create(project.id, 'Thread')).status,
      'inactive',
    );
    assert.equal((await service.projects.ssh(project.id)).status, 'expired');
    await service.dispose();
  },
);

test(
  'queues one correlated delegation result for its busy parent and keeps later human input independent',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const spawned = deferred<{ threadId: string; promptId: string }>();
    const childStarted = deferred();
    const finishChild = deferred();
    const finishParent = deferred();
    const resumed = deferred();
    const humanStarted = deferred();
    const priorHumanStarted = deferred();
    const childInputs: InputSource[] = [];
    const results: InputSource[] = [];
    const parentInputs: string[] = [];
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job, coordination }) => {
        if (job.prompt === 'coordinate') {
          spawned.resolve(await coordination.spawn('delegated'));
          await finishParent.promise;
        } else if (job.prompt === 'delegated') {
          childInputs.push(job.source);
          childStarted.resolve();
          await finishChild.promise;
          return 'child result';
        } else if (job.prompt === 'human follow-up') {
          childInputs.push(job.source);
          humanStarted.resolve();
        } else if (job.source.kind === 'result') {
          parentInputs.push('result');
          results.push(job.source);
          resumed.resolve();
        } else if (job.prompt === 'prior human input') {
          parentInputs.push(job.prompt);
          priorHumanStarted.resolve();
        }
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const parent = await createThread(service, project.id);
    const request = await service.threads.prompt(parent.id, 'coordinate');
    assert.ok(request.status === 'accepted');
    const child = await spawned.promise;
    await childStarted.promise;
    await service.threads.prompt(parent.id, 'prior human input');
    assert.equal(
      (await service.threads.prompt(child.threadId, 'human follow-up')).status,
      'accepted',
    );
    finishChild.resolve();
    await humanStarted.promise;
    await harness.threadState(child.threadId, 'ready');
    assert.deepEqual(results, []);
    assert.deepEqual(childInputs, [
      { kind: 'parent', threadId: parent.id, promptId: request.promptId },
      { kind: 'user' },
    ]);
    finishParent.resolve();
    await resumed.promise;
    await priorHumanStarted.promise;
    await harness.threadState(parent.id, 'ready');
    assert.deepEqual(parentInputs, ['prior human input', 'result']);
    assert.deepEqual(results, [
      {
        kind: 'result',
        threadId: child.threadId,
        promptId: child.promptId,
        requestPromptId: request.promptId,
      },
    ]);
    await service.dispose();
  },
);

test(
  'does not reopen a terminated parent when its delegated execution finishes late',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const spawned = deferred<{ threadId: string; promptId: string }>();
    const childStarted = deferred();
    const finishChild = deferred();
    let resumed = false;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      execute: async ({ job, coordination }) => {
        if (job.prompt === 'coordinate') {
          spawned.resolve(await coordination.spawn('delegated'));
        } else if (job.prompt === 'delegated') {
          childStarted.resolve();
          await finishChild.promise;
        } else if (job.source.kind === 'result') resumed = true;
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const parent = await createThread(service, project.id);
    await service.threads.prompt(parent.id, 'coordinate');
    const child = await spawned.promise;
    await childStarted.promise;
    await harness.threadState(parent.id, 'ready');
    await service.threads.terminate(parent.id);
    assert.notEqual(
      (await service.threads.create(project.id, 'Grandchild', child.threadId))
        .status,
      'created',
    );
    finishChild.resolve();
    await harness.threadState(child.threadId, 'cancelled');
    await harness.threadState(parent.id, 'cancelled');
    assert.equal(resumed, false);
    assert.equal(
      (await service.threads.prompt(parent.id, 'later')).status,
      'inactive',
    );
    await service.dispose();
  },
);
