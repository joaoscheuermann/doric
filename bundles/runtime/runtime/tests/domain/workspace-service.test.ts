import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  type InputSource,
  isProjectColor,
  type Project,
  type Thread,
} from '../../src/contracts/model.js';
import { createHarness, deferred, spawner } from './support/harness.js';

/*
 * Ported from agents/doric tests/workspace-service.test.ts (design 57 §13.1,
 * stage 5 "Creation, tree", "Parallelism", "Delegation"): the same cases,
 * through the runtime contracts, over the real store on memory storage.
 */

const secret = {
  id: 'c1',
  kind: 'API_TOKEN',
  name: 'Key',
  secret: 'secret-value',
} as const;

void test('creates, lists, and renames named Projects and Threads', async () => {
  const harness = createHarness();
  const { service } = harness;
  const project = await service.projects.create('Initial project');
  const thread = await harness.createThread(project.id);
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
  await harness.dispose();
});

void test('marks each new Project with a color from the host palette', async () => {
  const harness = createHarness();
  const { service } = harness;
  const projects = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      service.projects.create(`Project ${index}`),
    ),
  );
  for (const project of projects) {
    assert.ok(
      isProjectColor(project.color),
      `expected a palette color, got ${String(project.color)}`,
    );
    assert.equal(
      (await service.projects.find(project.id))?.color,
      project.color,
    );
  }
  await harness.dispose();
});

void test('serializes Project rename with terminal state publication', async () => {
  const harness = createHarness();
  const { service } = harness;
  const stateCaptured = deferred();
  const releaseState = deferred();
  const setState = harness.stores.projects.setState;
  harness.stores.projects.setState = async (...args) => {
    const value = await setState(...args);
    if (args[1] === 'cancelled') {
      stateCaptured.resolve();
      await releaseState.promise;
    }
    return value;
  };
  const project = await harness.readyProject('Initial');
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
  const updates = harness.notices.flatMap((notice) =>
    notice.kind === 'projectUpdated' ? [notice.value as Project] : [],
  );
  assert.equal(updates.at(-1)?.name, 'Renamed');
  assert.equal((await service.projects.find(project.id))?.name, 'Renamed');
  await harness.dispose();
});

void test('serializes Thread rename with terminal state publication', async () => {
  const harness = createHarness();
  const { service } = harness;
  const stateCaptured = deferred();
  const releaseState = deferred();
  const setState = harness.stores.threads.setState;
  harness.stores.threads.setState = async (...args) => {
    const value = await setState(...args);
    if (args[1] === 'cancelled') {
      stateCaptured.resolve();
      await releaseState.promise;
    }
    return value;
  };
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
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
  const updates = harness.notices.flatMap((notice) =>
    notice.kind === 'threadUpdated' ? [notice.value as Thread] : [],
  );
  assert.equal(updates.at(-1)?.name, 'Renamed');
  assert.equal((await service.threads.find(thread.id))?.name, 'Renamed');
  await harness.dispose();
});

void test('derives delegated Thread names without splitting Unicode characters', async () => {
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const prompt = '😀'.repeat(81);
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'coordinate')
        spawned.resolve(await tools.threads.spawn(prompt));
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'coordinate');
  const child = await spawned.promise;
  assert.equal(
    (await service.threads.find(child.threadId))?.name,
    '😀'.repeat(80),
  );
  await harness.dispose();
});

void test('names a delegated Thread after its title instead of its prompt', async () => {
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'coordinate')
        spawned.resolve(
          await tools.threads.spawn(
            'Audit every package',
            `  ${'t'.repeat(81)} `,
          ),
        );
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'coordinate');
  const child = await spawned.promise;
  assert.equal(
    (await service.threads.find(child.threadId))?.name,
    't'.repeat(80),
  );
  await harness.dispose();
});

void test('refuses to delegate under a blank title', async () => {
  const refused = deferred<unknown>();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'coordinate')
        await tools.threads.spawn('task', '   ').catch(refused.resolve);
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'coordinate');
  assert.ok((await refused.promise) instanceof TypeError);
  assert.deepEqual(
    (await service.threads.list(project.id, 10))?.items.map(({ id }) => id),
    [parent.id],
  );
  await harness.dispose();
});

void test('shares one Project lease while Threads run independently and each preserves FIFO', {
  timeout: 5000,
}, async () => {
  const firstStarted = deferred();
  const otherStarted = deferred();
  const secondStarted = deferred();
  const thirdStarted = deferred();
  const finishFirst = deferred();
  const finishOther = deferred();
  const calls: string[] = [];
  const sandboxes: string[] = [];
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      calls.push(job.prompt);
      sandboxes.push((await tools.lease.describe()).id);
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
  const { service } = harness;
  const project = await harness.readyProject();
  const first = await harness.createThread(project.id);
  const other = await harness.createThread(project.id);
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
  assert.equal(harness.sandbox.acquired.length, 1);
  finishOther.resolve();
  await harness.dispose();
});

void test('pauses reader dispatch without interrupting the daughter Thread', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const childStarted = deferred();
  const finishChild = deferred();
  const interrupted = deferred();
  const finishInterrupted = deferred();
  let nextSignal: AbortSignal | undefined;
  let childSignal: AbortSignal | undefined;
  const harness = createHarness({
    execute: async ({ job, signal }) => {
      if (job.prompt === 'first') {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        interrupted.resolve();
        await finishInterrupted.promise;
      } else if (job.prompt === 'child') {
        childSignal = signal;
        childStarted.resolve();
        await finishChild.promise;
      } else {
        nextSignal = signal;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, parent.id);
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
  await harness.threadState(parent.id, 'ready');
  assert.equal(
    await service.threads.interrupt(parent.id, prompt.promptId),
    'interrupted',
  );
  assert.equal(nextSignal, undefined);
  assert.equal((await service.threads.queue(parent.id))?.paused, true);
  assert.deepEqual(
    (await service.threads.queue(parent.id))?.items.map((item) => item.preview),
    ['next'],
  );
  assert.equal(childSignal?.aborted, false);
  finishChild.resolve();
  await harness.dispose();
});

void test('terminates a subtree without terminating its sibling or Project', {
  timeout: 5000,
}, async () => {
  const tree = spawner();
  const harness = createHarness({ execute: tree.execute });
  const { service } = harness;
  const project = await harness.readyProject();
  const root = await harness.createThread(project.id);
  const child = await harness.createThread(project.id, root.id);
  const otherChild = await harness.createThread(project.id, root.id);
  // The reader branches a main Thread; what hangs under a sub-thread is the
  // agent Thread that sub-thread spawns, as in the product.
  const agentThreads: string[] = [];
  for (const subThread of [child, otherChild]) {
    assert.equal(
      (await service.threads.prompt(subThread.id, 'spawn')).status,
      'accepted',
    );
    agentThreads.push(await tree.spawned(subThread.id));
  }
  const sibling = await harness.createThread(project.id);
  await service.threads.terminate(root.id);
  const subtree: readonly (readonly [string, string])[] = [
    [root.id, 'inactive'],
    [child.id, 'inactive'],
    [otherChild.id, 'inactive'],
    ...agentThreads.map((id) => [id, 'forbidden'] as const),
  ];
  for (const [id, answer] of subtree) {
    await harness.threadState(id, 'cancelled');
    // A cancelled Thread takes no work: the reader's own answers `inactive`, and
    // an agent Thread `forbidden` before its state is even read.
    assert.equal((await service.threads.prompt(id, 'later')).status, answer);
    assert.notEqual(
      (await service.threads.create(project.id, 'Child', id)).status,
      'created',
    );
  }
  assert.equal(
    (await service.threads.prompt(sibling.id, 'work')).status,
    'accepted',
  );
  assert.equal((await service.projects.find(project.id))?.state, 'ready');
  await harness.dispose();
});

void test('blocks creation during Project termination and releases once after execution stops', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const aborted = deferred();
  const finish = deferred();
  const harness = createHarness({
    execute: async ({ signal }) => {
      signal?.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      });
      started.resolve();
      await finish.promise;
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await service.threads.prompt(thread.id, 'work');
  await started.promise;
  const pending = await service.threads.prompt(thread.id, 'queued');
  assert.ok(pending.status === 'accepted');
  await service.projects.terminate(project.id);
  await aborted.promise;
  assert.equal(harness.sandbox.released, 0);
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
  assert.equal(harness.sandbox.released, 1);
  assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
  const history = await service.threads.events(thread.id, 0);
  assert.ok(
    history?.events.some(
      (event) =>
        event.promptId === pending.promptId && event.type === 'agent.cancelled',
    ),
  );
  await harness.dispose();
});

void test('keeps queued work usable after a prompt fails without exposing execution secrets', {
  timeout: 5000,
}, async () => {
  const nextStarted = deferred();
  const harness = createHarness({
    credentials: () => [secret],
    execute: async ({ job }) => {
      if (job.prompt === 'broken') throw new Error('credential secret-value');
      nextStarted.resolve();
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
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
  await harness.dispose();
});

void test('accepts many simultaneous Threads without imposing execution slots', {
  timeout: 5000,
}, async () => {
  const allStarted = deferred();
  const finish = deferred();
  const count = 24;
  const running = new Set<string>();
  const harness = createHarness({
    execute: async ({ thread }) => {
      running.add(thread.id);
      if (running.size === count) allStarted.resolve();
      await finish.promise;
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const threads = await Promise.all(
    Array.from({ length: count }, () => harness.createThread(project.id)),
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
  await harness.dispose();
});

void test('fails the Project when acquiring its sandbox fails', {
  timeout: 5000,
}, async () => {
  const harness = createHarness({
    sandbox: {
      acquire: async () => {
        throw new Error('secret-value');
      },
    },
  });
  const { service } = harness;
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
  await harness.dispose();
});

void test('steers one correlated delegation result into its busy parent and keeps later human input independent', {
  timeout: 5000,
}, async () => {
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const childStarted = deferred();
  const finishChild = deferred();
  const childFinished = deferred();
  const priorHumanStarted = deferred();
  const childInputs: InputSource[] = [];
  const steered: InputSource[] = [];
  const parentInputs: string[] = [];
  const harness = createHarness({
    execute: async ({ job, tools, session }) => {
      if (job.prompt === 'coordinate') {
        spawned.resolve(await tools.threads.spawn('delegated'));
        await childFinished.promise;
        // The parent's safe point: the child's result arrives as a steer.
        await harness.waitFor(async () => {
          const steers = (await session.steers?.()) ?? [];
          for (const steer of steers) {
            steered.push(steer.source);
            await session.record({ event: { type: 'agent.steered' } });
          }
          return steered.length > 0;
        }, 'the result steer');
      } else if (job.prompt === 'delegated') {
        childInputs.push(job.source);
        childStarted.resolve();
        await finishChild.promise;
        return 'child result';
      } else if (job.source.kind === 'result') {
        parentInputs.push('result');
      } else if (job.prompt === 'prior human input') {
        parentInputs.push(job.prompt);
        priorHumanStarted.resolve();
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const request = await service.threads.prompt(parent.id, 'coordinate');
  assert.ok(request.status === 'accepted');
  const child = await spawned.promise;
  await childStarted.promise;
  await service.threads.prompt(parent.id, 'prior human input');
  // The child is an agent Thread: the reader writes nothing into it. Its work
  // belongs to the agent that spawned it, and the result arrives at the parent.
  assert.equal(
    (await service.threads.prompt(child.threadId, 'human follow-up')).status,
    'forbidden',
  );
  finishChild.resolve();
  await harness.threadState(child.threadId, 'ready');
  childFinished.resolve();
  await priorHumanStarted.promise;
  await harness.threadState(parent.id, 'ready');
  assert.deepEqual(childInputs, [
    { kind: 'parent', threadId: parent.id, promptId: request.promptId },
  ]);
  // The result reached the running prompt and never ran as a prompt of its own.
  assert.deepEqual(steered, [
    {
      kind: 'result',
      threadId: child.threadId,
      promptId: child.promptId,
      requestPromptId: request.promptId,
    },
  ]);
  assert.deepEqual(parentInputs, ['prior human input']);
  await harness.dispose();
});

void test('does not reopen a terminated parent when its delegated execution finishes late', {
  timeout: 5000,
}, async () => {
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const childStarted = deferred();
  const finishChild = deferred();
  let resumed = false;
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt === 'coordinate') {
        spawned.resolve(await tools.threads.spawn('delegated'));
      } else if (job.prompt === 'delegated') {
        childStarted.resolve();
        await finishChild.promise;
      } else if (job.source.kind === 'result') resumed = true;
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
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
  await harness.dispose();
});

void test('a Project created later stores the configuration in force at its creation', async () => {
  let revision = 1;
  const harness = createHarness({
    configuration: () => ({
      configuration: {
        providers: [],
        models: { execution: { providerId: 'p', model: 'm' } },
        execution: { maxTurns: 1 },
      },
      revision,
      updatedAt: new Date(0).toISOString(),
    }),
  });
  const first = await harness.service.projects.create('One');
  revision = 2;
  const second = await harness.service.projects.create('Two');
  assert.deepEqual([first.configRevision, second.configRevision], [1, 2]);
  await harness.dispose();
});
