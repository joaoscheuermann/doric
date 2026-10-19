import assert from 'node:assert/strict';
import test from 'node:test';

import type { InputSource } from '../../src/contracts/model.js';
import type { RuntimeThreads } from '../../src/contracts/threads.js';
import { createHarness, deferred, spawner } from './support/harness.js';

/*
 * Ported from agents/doric tests/workspace-lifecycle.test.ts (design 57
 * §13.1, stage 5 "Deletion"), over the real store: a subtree deletion is
 * refused while the subtree is active and accepted once it is terminal.
 */

void test('publishes deletion for the entire subtree only after the store accepts it', {
  timeout: 3000,
}, async () => {
  const tree = spawner();
  const harness = createHarness({ execute: tree.execute });
  const { service } = harness;
  const deleted: string[] = [];
  harness.listen((notice) => {
    if (notice.kind === 'threadDeleted') deleted.push(notice.threadId);
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const create = async (parentId?: string) => {
    const result = await service.threads.create(project.id, 'Thread', parentId);
    assert.ok(result.status === 'created');
    return result.thread;
  };
  const root = await create();
  const child = await create(root.id);
  const otherChild = await create(root.id);
  // What hangs under a sub-thread is the agent Thread that sub-thread spawns:
  // the reader branches a main Thread, and only an agent nests deeper.
  const agentThreads: string[] = [];
  for (const subThread of [child, otherChild]) {
    assert.equal(
      (await service.threads.prompt(subThread.id, 'spawn')).status,
      'accepted',
    );
    agentThreads.push(await tree.spawned(subThread.id));
  }
  const sibling = await create();
  const subtree = [root.id, child.id, otherChild.id, ...agentThreads];

  assert.equal(await service.threads.delete(root.id), 'active');
  assert.deepEqual(deleted, []);
  await service.threads.terminate(root.id);
  for (const id of subtree) {
    await harness.threadState(id, 'cancelled');
  }
  assert.equal(await service.threads.delete(root.id), 'deleted');
  assert.equal(deleted.length, subtree.length);
  assert.deepEqual(new Set(deleted), new Set(subtree));
  for (const id of deleted) {
    assert.equal(
      (await service.threads.create(project.id, 'Child', id)).status,
      'invalid_parent',
    );
  }
  assert.equal(
    (await service.threads.prompt(sibling.id, 'still available')).status,
    'accepted',
  );
  assert.equal((await service.projects.find(project.id))?.state, 'ready');
  await harness.dispose();
});

void test('exposes SSH only for the active Project lease, not pending disposal', {
  timeout: 5000,
}, async () => {
  const acquired = deferred();
  const releasing = deferred();
  const disposed = deferred();
  const ssh = {
    host: '127.0.0.1',
    port: 2200,
    username: 'root' as const,
    privateKey: 'test-private-key',
    knownHosts: 'test-host',
    hostKeyFingerprint: 'SHA256:test',
  };
  const harness = createHarness({
    sandbox: {
      acquire: async () => {
        await acquired.promise;
        return {
          sandbox: { id: 'leased-vm', ssh: async () => ssh },
          release: async () => {
            releasing.resolve();
            await disposed.promise;
          },
        } as never;
      },
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  assert.equal((await service.projects.ssh(project.id)).status, 'pending');
  assert.equal(await service.sshForVm('leased-vm'), undefined);
  acquired.resolve();
  await harness.projectState(project.id, 'ready');
  assert.deepEqual(await service.projects.ssh(project.id), {
    status: 'ready',
    vmId: 'leased-vm',
    ssh,
  });
  assert.deepEqual(await service.sshForVm('leased-vm'), {
    projectId: project.id,
    ssh,
  });
  assert.equal(await service.sshForVm('idle-vm'), undefined);
  await service.projects.terminate(project.id);
  assert.deepEqual(await service.projects.ssh(project.id), {
    status: 'unavailable',
  });
  assert.equal(await service.sshForVm('leased-vm'), undefined);
  await releasing.promise;
  assert.equal(await service.sshForVm('leased-vm'), undefined);
  disposed.resolve();
  await service.dispose();
  assert.equal((await service.projects.ssh(project.id)).status, 'expired');
  assert.equal(await service.sshForVm('leased-vm'), undefined);
  await harness.dispose();
});

void test('waits for both independently active Threads before releasing the Project', {
  timeout: 5000,
}, async () => {
  const starts = [deferred(), deferred()];
  const finishes = [deferred(), deferred()];
  const signals: (AbortSignal | undefined)[] = [];
  let releases = 0;
  const harness = createHarness({
    sandbox: {
      release: () => {
        releases += 1;
      },
    },
    execute: async ({ job, signal }) => {
      const index = Number(job.prompt);
      signals[index] = signal;
      starts[index].resolve();
      await finishes[index].promise;
      return 'done';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const ids: string[] = [];
  for (const index of [0, 1]) {
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    ids.push(created.thread.id);
    await service.threads.prompt(created.thread.id, String(index));
  }
  await Promise.all(starts.map(({ promise }) => promise));
  await service.projects.terminate(project.id);
  assert.ok(signals.every((signal) => signal?.aborted));
  assert.equal(releases, 0);
  finishes[0].resolve();
  await harness.threadState(ids[0], 'cancelled');
  assert.equal(releases, 0);
  assert.equal((await service.threads.find(ids[1]))?.state, 'cancelling');
  finishes[1].resolve();
  await service.dispose();
  assert.equal(releases, 1);
  assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
  await harness.dispose();
});

for (const outcome of ['failed', 'cancelled'] as const) {
  void test(`delivers a correlated ${outcome} child result to its parent`, {
    timeout: 5000,
  }, async () => {
    const spawned = deferred<{ threadId: string; promptId: string }>();
    const started = deferred();
    const finish = deferred();
    const delivered = deferred<{ source: InputSource; prompt: string }>();
    let coordinate: RuntimeThreads | undefined;
    const harness = createHarness({
      execute: async ({ job, tools }) => {
        if (job.prompt === 'coordinate') {
          coordinate = tools.threads;
          spawned.resolve(await tools.threads.spawn('child'));
          // Stay in the prompt while the child works, so the facade the test
          // interrupts through is still the one its prompt owns.
          await finish.promise;
        } else if (job.source.kind === 'parent') {
          started.resolve();
          await finish.promise;
          if (outcome === 'failed') throw new Error('child failure');
        } else if (job.source.kind === 'result') {
          delivered.resolve({ source: job.source, prompt: job.prompt });
        }
        return 'done';
      },
    });
    const { service } = harness;
    const project = await service.projects.create('Project');
    const parent = await service.threads.create(project.id, 'Parent');
    assert.ok(parent.status === 'created');
    const request = await service.threads.prompt(
      parent.thread.id,
      'coordinate',
    );
    assert.ok(request.status === 'accepted');
    const child = await spawned.promise;
    await started.promise;
    if (outcome === 'cancelled') {
      // A parent Thread stops a child outright; only the reader's own stop
      // pauses a run, which is why this goes through the parent's facade.
      assert.ok(coordinate !== undefined);
      assert.equal(
        await coordinate.interrupt(child.threadId, child.promptId),
        'interrupted',
      );
    }
    finish.resolve();
    const result = await delivered.promise;
    assert.deepEqual(result.source, {
      kind: 'result',
      threadId: child.threadId,
      promptId: child.promptId,
      requestPromptId: request.promptId,
    });
    assert.match(result.prompt, new RegExp(outcome, 'u'));
    await harness.threadState(parent.thread.id, 'ready');
    const events = await service.threads.events(child.threadId, 0);
    assert.ok(
      events?.events.some(
        ({ promptId, type, event }) =>
          promptId === child.promptId &&
          type === 'prompt.finished' &&
          (event as { status?: string }).status === outcome,
      ),
    );
    await harness.dispose();
  });
}

void test('a deletion over the storage batch limit is refused, logged and changes nothing', async () => {
  const harness = createHarness();
  const { service } = harness;
  const project = await harness.readyProject();
  await service.projects.terminate(project.id);
  await harness.projectState(project.id, 'cancelled');
  harness.stores.projects.delete = async () => {
    throw Object.assign(new Error('The batch is too large.'), {
      code: 'limit_exceeded',
    });
  };
  await assert.rejects(service.projects.delete(project.id), {
    code: 'limit_exceeded',
  });
  assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
  assert.ok(
    harness.logs.some(
      ({ level, message, fields }) =>
        level === 'error' &&
        message === 'Deletion exceeds the storage batch limit' &&
        fields?.projectId === project.id,
    ),
  );
  assert.deepEqual(harness.sandbox.discarded, []);
  await harness.dispose();
});
