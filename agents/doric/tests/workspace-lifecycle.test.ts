import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceService } from '../src/lib/workspace-service.js';
import type { InputSource } from '../src/lib/workspace.js';
import { deferred, pool, workspace } from './helpers/workspace.js';

test(
  'exposes SSH only for the active Project lease, not pending disposal',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
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
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          await acquired.promise;
          return {
            sandbox: { id: 'leased-vm', ssh: async () => ssh },
            release: async () => {
              releasing.resolve();
              await disposed.promise;
            },
          };
        },
      } as never,
      execute: async () => 'done',
    });
    const project = await service.projects.create();
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
  },
);

test(
  'waits for both independently active Threads before releasing the Project',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const starts = [deferred(), deferred()];
    const finishes = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    let releases = 0;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(() => {
        releases += 1;
      }),
      execute: async ({ job, signal }) => {
        const index = Number(job.prompt);
        signals[index] = signal;
        starts[index].resolve();
        await finishes[index].promise;
        return 'done';
      },
    });
    const project = await service.projects.create();
    const ids: string[] = [];
    for (const index of [0, 1]) {
      const created = await service.threads.create(project.id);
      assert.ok(created.status === 'created');
      ids.push(created.thread.id);
      await service.threads.prompt(created.thread.id, String(index));
    }
    await Promise.all(starts.map(({ promise }) => promise));
    await service.projects.terminate(project.id);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(releases, 0);
    finishes[0].resolve();
    await harness.threadState(ids[0], 'cancelled');
    assert.equal(releases, 0);
    assert.equal((await service.threads.find(ids[1]))?.state, 'cancelling');
    finishes[1].resolve();
    await service.dispose();
    assert.equal(releases, 1);
    assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
  },
);

for (const outcome of ['failed', 'cancelled'] as const) {
  test(
    `delivers a correlated ${outcome} child result to its parent`,
    { timeout: 5000 },
    async () => {
      const harness = workspace();
      const spawned = deferred<{ threadId: string; promptId: string }>();
      const started = deferred();
      const finish = deferred();
      const delivered = deferred<{ source: InputSource; prompt: string }>();
      const service = createWorkspaceService({
        ...harness.dependencies,
        pool: pool(),
        execute: async ({ job, coordination }) => {
          if (job.prompt === 'coordinate') {
            spawned.resolve(await coordination.spawn('child'));
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
      const project = await service.projects.create();
      const parent = await service.threads.create(project.id);
      assert.ok(parent.status === 'created');
      const request = await service.threads.prompt(
        parent.thread.id,
        'coordinate',
      );
      assert.ok(request.status === 'accepted');
      const child = await spawned.promise;
      await started.promise;
      if (outcome === 'cancelled') {
        assert.equal(
          await service.threads.interrupt(child.threadId, child.promptId),
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
      await service.dispose();
    },
  );
}
