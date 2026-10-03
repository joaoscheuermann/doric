import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecInput } from 'sandbox';

import { defaultConfig } from '../src/lib/config/schema.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { Thread, ThreadEvent } from '../src/lib/workspace/types.js';
import { deferred, fakeSandbox, workspace } from './helpers/workspace.js';

void test(
  'queues boot resumptions without waiting for sandbox capacity',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const snapshot = {
      configuration: defaultConfig,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    };
    const { project } = await harness.projects.create(
      'Waiting project',
      snapshot,
      'blue',
    );
    const { thread } = await harness.threads.create(project.id, 'Thread');
    await harness.threads.appendEvent(thread.id, 'queued-prompt', {
      type: 'prompt.accepted',
      text: 'work',
      source: { kind: 'user' },
    });
    const available = deferred();
    const completed = deferred();
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          await available.promise;
          return { sandbox: fakeSandbox(), release: () => Promise.resolve() };
        },
      } as never,
      execute: () => {
        completed.resolve();
        return Promise.resolve('done');
      },
    });
    try {
      assert.equal(await service.resumeInterrupted(), 1);
      assert.equal((await service.projects.find(project.id))?.state, 'queued');
      available.resolve();
      await completed.promise;
      await harness.threadState(thread.id, 'ready');
    } finally {
      available.resolve();
      await service.dispose();
    }
  },
);

/** The signed events of one prompt, in order. */
const eventsOf = (events: readonly ThreadEvent[], promptId: string) =>
  events.filter((event) => event.promptId === promptId);

/** The one lease-time working-directory probe a sandbox received, if any. */
const validateCommands = (execs: readonly SandboxExecInput[]) =>
  execs.filter(({ cmd }) => cmd.includes('cwd-validate'));

test(
  'a host stop suspends the Project and its Threads instead of terminating them',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    let releases = 0;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => {
            releases += 1;
          },
        }),
      } as never,
      execute: async ({ job, signal }) => {
        if (job.prompt === 'work') {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return 'done';
      },
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    const running = await service.threads.prompt(created.thread.id, 'work');
    assert.ok(running.status === 'accepted');
    await started.promise;
    const queued = await service.threads.prompt(created.thread.id, 'queued');
    assert.ok(queued.status === 'accepted');

    await service.dispose();

    // The Project needs a sandbox again and its Thread is ready to run; neither
    // is terminal, so the next boot resumes them.
    assert.equal((await service.projects.find(project.id))?.state, 'queued');
    const record = await service.threads.find(created.thread.id);
    assert.equal(record?.state, 'ready');
    assert.equal(record?.activePromptId, undefined);
    // The prompt that was running is *paused*, not closed: it keeps no result
    // and no finish, so the next boot takes it up again. The queued one never
    // ran, so it is left accepted and unfinished for the same resume.
    assert.equal(record?.result, undefined);
    const events =
      (await service.threads.events(created.thread.id, 0))?.events ?? [];
    const paused = eventsOf(events, running.promptId);
    assert.ok(
      paused.some(
        ({ type, event }) =>
          type === 'prompt.paused' &&
          (event as { reason?: string }).reason === 'host_stopped',
      ),
      'the running prompt is paused by the host stop',
    );
    for (const promptId of [running.promptId, queued.promptId]) {
      const own = eventsOf(events, promptId);
      assert.equal(
        own.some(({ type }) => type === 'prompt.finished'),
        false,
        'a paused prompt, and one that never started, stay unfinished',
      );
      assert.equal(
        own.some(({ type }) => type === 'agent.cancelled'),
        false,
        'a pause is not a cancellation',
      );
    }
    // The lease is released exactly once.
    assert.equal(releases, 1);
  },
);

test(
  'a prompt resumes a queued Project on demand and reacquires its own identity',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await first.dispose();
    assert.equal((await first.projects.find(project.id))?.state, 'queued');

    // A second host over the same durable records: no runtime until a prompt.
    const acquisitions: { readonly identity?: string }[] = [];
    const executed: string[] = [];
    const ran = deferred();
    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async (options: { readonly identity?: string }) => {
          acquisitions.push(options);
          return { sandbox: fakeSandbox(), release: async () => undefined };
        },
      } as never,
      execute: async ({ job }) => {
        executed.push(job.prompt);
        ran.resolve();
        return 'done';
      },
    });

    // A read that needs a lease does not resume: it answers unavailable and
    // acquires nothing.
    assert.equal(
      (await second.projects.files(project.id)).status,
      'unavailable',
    );
    assert.equal(acquisitions.length, 0);

    const accepted = await second.threads.prompt(
      created.thread.id,
      'resume me',
    );
    assert.ok(accepted.status === 'accepted');
    await ran.promise;
    await harness.threadState(created.thread.id, 'ready');
    assert.deepEqual(executed, ['resume me']);
    assert.equal(acquisitions.length, 1);
    assert.equal(acquisitions[0]?.identity, project.id);
    assert.equal(
      (await second.threads.find(created.thread.id))?.state,
      'ready',
    );
    await second.dispose();
  },
);

test(
  'an acquisition that fails while resuming leaves the Project failed and the prompt inactive',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await first.dispose();

    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          throw new Error('no sandbox');
        },
      } as never,
      execute: async () => 'unused',
    });
    assert.equal(
      (await second.threads.prompt(created.thread.id, 'resume me')).status,
      'inactive',
    );
    await harness.projectState(project.id, 'failed');
    assert.equal(
      (await second.projects.find(project.id))?.errorCode,
      'sandbox_acquisition_failed',
    );
    await second.dispose();
  },
);

test(
  'one acquire validates every Thread working directory and resets the missing ones',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox(),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const create = async () => {
      const result = await first.threads.create(project.id, 'Thread');
      assert.ok(result.status === 'created');
      return result.thread;
    };
    const kept = await create();
    const gone = await create();
    const file = await create();
    const root = await create();
    // The durable records describe a workspace the reacquired volume no longer
    // holds: this is exactly the drift a restart has to correct.
    await harness.threads.setCwd(kept.id, '/workspace/keep', 'git');
    await harness.threads.setCwd(gone.id, '/workspace/gone');
    await harness.threads.setCwd(file.id, '/workspace/readme.txt');
    await first.dispose();

    const sandbox = fakeSandbox({
      entries: [{ path: 'keep' }, { path: 'readme.txt', content: 'x' }],
    });
    const updated: Thread[] = [];
    const second = createWorkspaceService({
      ...harness.dependencies,
      publisher: {
        ...harness.publisher,
        threadUpdated: (value) => {
          updated.push(value);
          harness.publisher.threadUpdated(value);
        },
      },
      pool: {
        acquire: async () => ({ sandbox, release: async () => undefined }),
      } as never,
      execute: async () => 'done',
    });
    const accepted = await second.threads.prompt(gone.id, 'run where I am');
    assert.ok(accepted.status === 'accepted');

    // The probe is one command naming every non-root Thread, and never the root.
    const probes = validateCommands(sandbox.execs);
    assert.equal(probes.length, 1);
    assert.deepEqual(
      new Set(probes[0]?.cmd.slice(5)),
      new Set(['/workspace/keep', '/workspace/gone', '/workspace/readme.txt']),
    );

    // A directory that still exists keeps its directory and hint; a missing one
    // and one that is no longer a directory reset to the workspace root with the
    // hint cleared and one publication each.
    assert.equal((await second.threads.find(kept.id))?.cwd, '/workspace/keep');
    assert.equal((await second.threads.find(kept.id))?.cwdRepo, 'git');
    for (const id of [gone.id, file.id]) {
      const record = await second.threads.find(id);
      assert.equal(record?.cwd, '/workspace');
      assert.equal(record?.cwdRepo, undefined);
      assert.ok(
        updated.some((value) => value.id === id && value.cwd === '/workspace'),
      );
    }
    assert.ok(
      updated
        .filter((value) => value.id === kept.id)
        .every((value) => value.cwd === '/workspace/keep'),
    );
    assert.equal((await second.threads.find(root.id))?.cwd, '/workspace');
    await second.dispose();
  },
);

test(
  'terminating a queued Project without a runtime stays terminal without acquiring one',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await first.dispose();

    let acquisitions = 0;
    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          acquisitions += 1;
          return { sandbox: fakeSandbox(), release: async () => undefined };
        },
      } as never,
      execute: async () => 'done',
    });
    assert.equal(
      (await second.projects.terminate(project.id))?.state,
      'cancelling',
    );
    await harness.projectState(project.id, 'cancelled');
    assert.equal(
      (await second.threads.find(created.thread.id))?.state,
      'cancelled',
    );
    // Terminating closes the Project for good: a later prompt never resumes it.
    assert.equal(
      (await second.threads.prompt(created.thread.id, 'too late')).status,
      'inactive',
    );
    assert.equal(acquisitions, 0);
    await second.dispose();
  },
);

test(
  'deleting a Project discards its workspace after the record is gone',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const discarded: { readonly identity: string; readonly state?: string }[] =
      [];
    const service = createWorkspaceService({
      ...harness.dependencies,
      discardWorkspace: async (identity: string) => {
        discarded.push({
          identity,
          state: (await harness.projects.record(identity))?.state,
        });
      },
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    await service.projects.terminate(project.id);
    await harness.projectState(project.id, 'cancelled');

    assert.equal(await service.projects.delete(project.id), 'deleted');
    // The record was already gone when the volume was discarded.
    assert.deepEqual(discarded, [{ identity: project.id, state: undefined }]);
    assert.equal(await service.projects.find(project.id), undefined);
    await service.dispose();
  },
);

test(
  'a workspace discard that fails never fails the deletion',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const service = createWorkspaceService({
      ...harness.dependencies,
      discardWorkspace: async () => {
        throw new Error('discard failed');
      },
      pool: {
        acquire: async () => ({
          sandbox: { id: 'vm-1' },
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    await service.projects.terminate(project.id);
    await harness.projectState(project.id, 'cancelled');

    assert.equal(await service.projects.delete(project.id), 'deleted');
    assert.equal(await service.projects.find(project.id), undefined);
    await service.dispose();
  },
);

test(
  'terminating a Thread of a Project with no runtime cancels it durably',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox(),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const create = async (parentId?: string) => {
      const result = await first.threads.create(project.id, 'Thread', parentId);
      assert.ok(result.status === 'created');
      return result.thread;
    };
    const root = await create();
    const child = await create(root.id);
    const sibling = await create();
    await first.dispose();

    // A second host over the same durable records: no runtime until something
    // prompts the Project, and terminate must not need one to have an effect.
    let acquisitions = 0;
    let deletedSubtreeWasTerminal = false;
    const second = createWorkspaceService({
      ...harness.dependencies,
      threads: {
        ...harness.threads,
        deleteSubtree: async () => {
          const target = await harness.threads.record(root.id);
          deletedSubtreeWasTerminal = target?.state === 'cancelled';
          return deletedSubtreeWasTerminal ? 'deleted' : 'active';
        },
      },
      pool: {
        acquire: async () => {
          acquisitions += 1;
          return { sandbox: fakeSandbox(), release: async () => undefined };
        },
      } as never,
      execute: async () => 'done',
    });
    const terminated = await second.threads.terminate(root.id);
    assert.equal(terminated?.state, 'cancelled');
    for (const thread of [root, child]) {
      assert.equal((await second.threads.find(thread.id))?.state, 'cancelled');
    }
    assert.equal((await second.threads.find(sibling.id))?.state, 'ready');
    // The durable subtree is terminal, so deleting it works exactly as after a
    // live termination, and termination never acquired a sandbox.
    assert.equal(await second.threads.delete(root.id), 'deleted');
    assert.ok(deletedSubtreeWasTerminal);
    assert.equal(acquisitions, 0);
    await second.dispose();
  },
);

test(
  'two prompts that arrive together keep arrival order on resume',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox(),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await first.dispose();

    const gate = deferred();
    const order: string[] = [];
    const done = deferred();
    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          await gate.promise;
          return { sandbox: fakeSandbox(), release: async () => undefined };
        },
      } as never,
      execute: async ({ job }) => {
        order.push(job.prompt);
        if (order.length === 2) done.resolve();
        return 'done';
      },
    });
    const one = second.threads.prompt(created.thread.id, 'first');
    // Let the first prompt reach its in-flight acquisition before the second
    // arrives, so the two must keep the order they arrived in.
    await new Promise((resolve) => setImmediate(resolve));
    const two = second.threads.prompt(created.thread.id, 'second');
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();
    const results = await Promise.all([one, two]);
    for (const result of results) assert.equal(result.status, 'accepted');
    await done.promise;
    assert.deepEqual(order, ['first', 'second']);
    await second.dispose();
  },
);

test(
  'a probe that cannot run keeps every stored directory and still acquires',
  { timeout: 3000 },
  async () => {
    for (const probe of [
      { name: 'a non-zero shell exit', throwing: false },
      { name: 'a transient provider failure', throwing: true },
    ]) {
      const harness = workspace();
      const first = createWorkspaceService({
        ...harness.dependencies,
        pool: {
          acquire: async () => ({
            sandbox: fakeSandbox(),
            release: async () => undefined,
          }),
        } as never,
        execute: async () => 'done',
      });
      const project = await first.projects.create('Project');
      await harness.projectState(project.id, 'ready');
      const created = await first.threads.create(project.id, 'Thread');
      assert.ok(created.status === 'created');
      await harness.threads.setCwd(created.thread.id, '/workspace/keep', 'git');
      await first.dispose();

      const sandbox = fakeSandbox({ entries: [{ path: 'keep' }] });
      const real = sandbox.exec;
      sandbox.exec = async (input) => {
        if (!input.cmd.includes('cwd-validate')) return real(input);
        if (probe.throwing) throw new Error('provider unreachable');
        return {
          exitCode: 127,
          stdout: '',
          stderr: 'sh: not found',
          stdoutBytes: new Uint8Array(),
          stderrBytes: new Uint8Array(),
        };
      };
      const second = createWorkspaceService({
        ...harness.dependencies,
        pool: {
          acquire: async () => ({
            sandbox,
            release: async () => undefined,
          }),
        } as never,
        execute: async () => 'done',
      });
      assert.equal(
        (await second.threads.prompt(created.thread.id, 'run')).status,
        'accepted',
        probe.name,
      );
      // A probe that proves nothing leaves the record alone and the acquisition
      // becomes ready instead of failing over it.
      const record = await second.threads.find(created.thread.id);
      assert.equal(record?.cwd, '/workspace/keep', probe.name);
      assert.equal(record?.cwdRepo, 'git', probe.name);
      assert.equal(
        (await second.projects.find(project.id))?.state,
        'ready',
        probe.name,
      );
      await second.dispose();
    }
  },
);

test(
  'a working directory path containing a newline survives reacquisition',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox(),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    const path = '/workspace/a\nb';
    await harness.threads.setCwd(created.thread.id, path, 'git');
    await first.dispose();

    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox({ entries: [{ path: 'a\nb' }] }),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    assert.equal(
      (await second.threads.prompt(created.thread.id, 'run')).status,
      'accepted',
    );
    // The directory is still held, so a path the delimiter protocol would have
    // split in two keeps its directory instead of resetting to the root.
    assert.equal((await second.threads.find(created.thread.id))?.cwd, path);
    await second.dispose();
  },
);

test(
  'terminating after disposal began never adds a runtime',
  { timeout: 3000 },
  async () => {
    const harness = workspace();
    const first = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => ({
          sandbox: fakeSandbox(),
          release: async () => undefined,
        }),
      } as never,
      execute: async () => 'done',
    });
    const project = await first.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await first.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await first.dispose();

    let acquisitions = 0;
    const second = createWorkspaceService({
      ...harness.dependencies,
      pool: {
        acquire: async () => {
          acquisitions += 1;
          return { sandbox: fakeSandbox(), release: async () => undefined };
        },
      } as never,
      execute: async () => 'done',
    });
    await second.dispose();
    // Shutdown owns the Project now: a termination arriving after disposal began
    // must not build a runtime and persist `cancelled` behind the suspender's
    // back, so it neither moves the Project nor acquires.
    const terminated = await second.projects.terminate(project.id);
    assert.equal(terminated?.state, 'queued');
    assert.equal((await second.projects.find(project.id))?.state, 'queued');
    assert.equal(acquisitions, 0);
  },
);
