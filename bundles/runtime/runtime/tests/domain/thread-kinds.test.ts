import assert from 'node:assert/strict';
import test from 'node:test';

import type { Thread } from '../../src/contracts/model.js';
import type { WorkspaceService } from '../../src/host/domain/types.js';
import { createHarness, deferred } from './support/harness.js';

/*
 * Who opened a Thread decides what the reader may do with it. The reader's own
 * Threads take prompts, steer, rewind and delete; an agent Thread — one the
 * `thread-spawn` tool created — takes only pause, continue and retry, and the
 * host refuses the rest. Retry is its own method because it sends the Thread's
 * last prompt from the log, never text the renderer chose.
 */

const create = async (
  service: WorkspaceService,
  projectId: string,
  parentId?: string,
): Promise<Thread> => {
  const value = await service.threads.create(projectId, 'Thread', parentId);
  assert.ok(value.status === 'created');
  return value.thread;
};

void test('an agent Thread takes only the reader’s three levers', {
  timeout: 5000,
}, async () => {
  const spawned = deferred<{ threadId: string; promptId: string }>();
  const release = deferred();
  const ran: string[] = [];
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      ran.push(job.prompt);
      if (job.prompt === 'parent') {
        spawned.resolve(await tools.threads.spawn('do the task'));
        await release.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const parent = await create(service, project.id);
  await service.threads.prompt(parent.id, 'parent');
  const { threadId } = await spawned.promise;

  // The agent owns the Thread: the reader writes nothing into it.
  assert.deepEqual(await service.threads.prompt(threadId, 'more'), {
    status: 'forbidden',
  });
  assert.deepEqual(
    await service.threads.steer(threadId, 'sideways', { promptId: 'x' }),
    { status: 'forbidden' },
  );
  assert.deepEqual(
    await service.threads.rewind(threadId, 'x', 'different words'),
    { status: 'forbidden' },
  );
  assert.equal(await service.threads.delete(threadId), 'forbidden');

  // Retry sends the Thread's own last prompt again: the reader chose no words.
  const retried = await service.threads.retry(threadId);
  assert.ok(retried.status === 'accepted');
  await harness.waitFor(
    () => ran.filter((prompt) => prompt === 'do the task').length === 2,
  );

  release.resolve();
  await harness.dispose();
});

void test('the reader may retry their own Thread too, from its last prompt', {
  timeout: 5000,
}, async () => {
  const ran: string[] = [];
  const harness = createHarness({
    execute: async ({ job }) => {
      ran.push(job.prompt);
      return 'done';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const parent = await create(service, project.id);
  await service.threads.prompt(parent.id, 'first');
  await harness.waitFor(() => ran.length === 1);

  const retried = await service.threads.retry(parent.id);
  assert.ok(retried.status === 'accepted');
  await harness.waitFor(() => ran.length === 2);
  assert.deepEqual(ran, ['first', 'first']);

  await harness.dispose();
});

void test('the reader hangs a Thread off the root, and only an agent nests deeper', {
  timeout: 5000,
}, async () => {
  const chain: { readonly parent: string; readonly child: string }[] = [];
  const settled = deferred();
  let spawning = 0;
  const harness = createHarness({
    execute: async ({ job, thread, tools }) => {
      // Two spawns: a sub-agent, and a sub-agent under it. The third Thread is
      // asked to spawn again and leaves the tree alone.
      if (job.prompt !== 'deeper' || spawning >= 2) return 'done';
      spawning += 1;
      const { threadId: child } = await tools.threads.spawn('deeper');
      chain.push({ parent: thread.id, child });
      if (chain.length === 2) settled.resolve();
      return 'done';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const main = await create(service, project.id);
  const subThread = await create(service, project.id, main.id);

  // The reader branches a main Thread, and nothing below one.
  assert.deepEqual(
    await service.threads.create(project.id, 'Deep', subThread.id),
    { status: 'invalid_parent' },
  );

  // An agent spawns under the Thread it works in, as deep as it needs to.
  assert.equal(
    (await service.threads.prompt(subThread.id, 'deeper')).status,
    'accepted',
  );
  await settled.promise;

  assert.equal(chain[0]?.parent, subThread.id);
  assert.equal(chain[1]?.parent, chain[0]?.child);
  for (const { parent, child } of chain) {
    const spawnedThread = await service.threads.find(child);
    assert.equal(spawnedThread?.origin, 'agent');
    assert.equal(spawnedThread?.parentThreadId, parent);
  }

  // Nor does the reader open anything under an agent Thread.
  const belowAgent = chain[0]?.child;
  assert.ok(belowAgent !== undefined);
  assert.deepEqual(
    await service.threads.create(project.id, 'Deep', belowAgent),
    { status: 'invalid_parent' },
  );

  await harness.dispose();
});
