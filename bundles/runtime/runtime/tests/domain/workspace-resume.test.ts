import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { SandboxExecInput } from 'sandbox';

import type { Thread, ThreadEvent } from '../../src/contracts/model.js';
import { type Backend, memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  defaultConfiguration,
  deferred,
  epoch,
  type HarnessOptions,
} from './support/harness.js';

/*
 * Ported from agents/doric tests/workspace-resume.test.ts (design 57 §13.1,
 * stage 5 "Restart"): a second runtime over the same durable records stands
 * for the next boot of the host.
 */

const snapshot = {
  configuration: defaultConfiguration,
  revision: 1,
  updatedAt: epoch,
};

/** One runtime over `backend`; another one over it is the next boot. */
const host = (backend: Backend, options: HarnessOptions = {}) =>
  createHarness({ backend, ...options });

/** The signed events of one prompt, in order. */
const eventsOf = (events: readonly ThreadEvent[], promptId: string) =>
  events.filter((event) => event.promptId === promptId);

/** The one lease-time working-directory probe a sandbox received, if any. */
const validateCommands = (execs: readonly SandboxExecInput[]) =>
  execs.filter(({ cmd }) => cmd.includes('cwd-validate'));

/** A first boot that leaves one ready Project with one Thread, then stops. */
const stoppedProject = async (backend: Backend, threads = 1) => {
  const first = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const project = await first.readyProject();
  const created: Thread[] = [];
  for (let index = 0; index < threads; index += 1)
    created.push(await first.createThread(project.id));
  return { first, project, threads: created };
};

void test('refuses a superseded pause through the service and after restart', async () => {
  const backend = memoryBackend();
  const harness = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const { stores, service } = harness;
  const { project } = await stores.projects.create('Project', snapshot, 'blue');
  const { thread } = await stores.threads.create(project.id, 'Thread');
  const old = randomUUID();
  const newer = randomUUID();
  await stores.threads.appendEvent(thread.id, old, {
    type: 'prompt.accepted',
    text: 'old work',
    source: { kind: 'user' },
  });
  await stores.threads.appendEvent(thread.id, old, {
    type: 'prompt.paused',
    reason: 'host_stopped',
  });
  await stores.threads.appendEvent(thread.id, newer, {
    type: 'prompt.accepted',
    text: 'new work',
    source: { kind: 'user' },
  });
  await stores.threads.appendEvent(thread.id, newer, {
    type: 'prompt.finished',
    text: 'done',
    status: 'completed',
    source: { kind: 'user' },
  });
  try {
    assert.deepEqual(await service.threads.resume(thread.id, old), {
      status: 'unknown_prompt',
    });
    assert.equal(await service.resumeInterrupted(), 0);
    assert.equal(
      (await stores.threads.eventsAfter(thread.id, 0)).some(
        (event) => event.type === 'prompt.resumed',
      ),
      false,
    );
  } finally {
    await harness.dispose();
    await backend.close();
  }
});

void test('queues boot resumptions without waiting for sandbox capacity', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const available = deferred();
  const completed = deferred();
  const harness = host(backend, {
    sandbox: {
      acquire: async () => {
        await available.promise;
        return {
          sandbox: fakeSandbox(),
          release: () => Promise.resolve(),
        } as never;
      },
    },
    execute: () => {
      completed.resolve();
      return Promise.resolve('done');
    },
  });
  const { stores, service } = harness;
  const { project } = await stores.projects.create(
    'Waiting project',
    snapshot,
    'blue',
  );
  const { thread } = await stores.threads.create(project.id, 'Thread');
  await stores.threads.appendEvent(thread.id, randomUUID(), {
    type: 'prompt.accepted',
    text: 'work',
    source: { kind: 'user' },
  });
  try {
    assert.equal(await service.resumeInterrupted(), 1);
    assert.equal((await service.projects.find(project.id))?.state, 'queued');
    available.resolve();
    await completed.promise;
    await harness.threadState(thread.id, 'ready');
  } finally {
    available.resolve();
    await harness.dispose();
    await backend.close();
  }
});

void test('a host stop suspends the Project and its Threads instead of terminating them', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const harness = createHarness({
    execute: async ({ job, signal }) => {
      if (job.prompt === 'work') {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
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
  assert.equal(harness.sandbox.released, 1);
  await harness.dispose();
});

void test('a prompt resumes a queued Project on demand and reacquires its own identity', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    project,
    threads: [created],
  } = await stoppedProject(backend);
  await first.service.dispose();
  assert.equal(
    (await first.service.projects.find(project.id))?.state,
    'queued',
  );
  await first.dispose();

  // A second host over the same durable records: no runtime until a prompt.
  const executed: string[] = [];
  const ran = deferred();
  const second = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ job }) => {
      executed.push(job.prompt);
      ran.resolve();
      return 'done';
    },
  });

  // A read that needs a lease does not resume: it answers unavailable and
  // acquires nothing.
  assert.equal(
    (await second.service.projects.files(project.id)).status,
    'unavailable',
  );
  assert.equal(second.sandbox.acquired.length, 0);

  const accepted = await second.service.threads.prompt(created.id, 'resume me');
  assert.ok(accepted.status === 'accepted');
  await ran.promise;
  await second.threadState(created.id, 'ready');
  assert.deepEqual(executed, ['resume me']);
  assert.deepEqual(second.sandbox.acquired, [project.id]);
  assert.equal((await second.service.threads.find(created.id))?.state, 'ready');
  await second.dispose();
  await backend.close();
});

void test('an acquisition that fails while resuming leaves the Project failed and the prompt inactive', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    project,
    threads: [created],
  } = await stoppedProject(backend);
  await first.dispose();

  const second = host(backend, {
    sandbox: {
      acquire: async () => {
        throw new Error('no sandbox');
      },
    },
  });
  assert.equal(
    (await second.service.threads.prompt(created.id, 'resume me')).status,
    'inactive',
  );
  await second.projectState(project.id, 'failed');
  assert.equal(
    (await second.service.projects.find(project.id))?.errorCode,
    'sandbox_acquisition_failed',
  );
  await second.dispose();
  await backend.close();
});

void test('one acquire validates every Thread working directory and resets the missing ones', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    project,
    threads: [kept, gone, file, root],
  } = await stoppedProject(backend, 4);
  // The durable records describe a workspace the reacquired volume no longer
  // holds: this is exactly the drift a restart has to correct.
  await first.stores.threads.setCwd(kept.id, '/workspace/keep', 'git');
  await first.stores.threads.setCwd(gone.id, '/workspace/gone');
  await first.stores.threads.setCwd(file.id, '/workspace/readme.txt');
  await first.dispose();
  assert.ok(project);

  const sandbox = fakeSandbox({
    entries: [{ path: 'keep' }, { path: 'readme.txt', content: 'x' }],
  });
  const second = host(backend, { sandbox: { sandbox: sandbox as never } });
  const updated = () =>
    second.notices.flatMap((notice) =>
      notice.kind === 'threadUpdated' ? [notice.value] : [],
    );
  const accepted = await second.service.threads.prompt(
    gone.id,
    'run where I am',
  );
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
  assert.equal(
    (await second.service.threads.find(kept.id))?.cwd,
    '/workspace/keep',
  );
  assert.equal((await second.service.threads.find(kept.id))?.cwdRepo, 'git');
  for (const id of [gone.id, file.id]) {
    const record = await second.service.threads.find(id);
    assert.equal(record?.cwd, '/workspace');
    assert.equal(record?.cwdRepo, undefined);
    assert.ok(
      updated().some((value) => value.id === id && value.cwd === '/workspace'),
    );
  }
  assert.ok(
    updated()
      .filter((value) => value.id === kept.id)
      .every((value) => value.cwd === '/workspace/keep'),
  );
  assert.equal((await second.service.threads.find(root.id))?.cwd, '/workspace');
  await second.dispose();
  await backend.close();
});

void test('terminating a queued Project without a runtime stays terminal without acquiring one', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    project,
    threads: [created],
  } = await stoppedProject(backend);
  await first.dispose();

  const second = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
  });
  assert.equal(
    (await second.service.projects.terminate(project.id))?.state,
    'cancelling',
  );
  await second.projectState(project.id, 'cancelled');
  assert.equal(
    (await second.service.threads.find(created.id))?.state,
    'cancelled',
  );
  // Terminating closes the Project for good: a later prompt never resumes it.
  assert.equal(
    (await second.service.threads.prompt(created.id, 'too late')).status,
    'inactive',
  );
  assert.equal(second.sandbox.acquired.length, 0);
  await second.dispose();
  await backend.close();
});

void test('deleting a Project discards its workspace after the record is gone', {
  timeout: 5000,
}, async () => {
  const discarded: { readonly identity: string; readonly state?: string }[] =
    [];
  const harness = createHarness({
    sandbox: {
      discard: async (identity: string) => {
        discarded.push({
          identity,
          state: (await harness.stores.projects.record(identity))?.state,
        });
      },
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await service.projects.terminate(project.id);
  await harness.projectState(project.id, 'cancelled');

  assert.equal(await service.projects.delete(project.id), 'deleted');
  // The record was already gone when the volume was discarded.
  assert.deepEqual(discarded, [{ identity: project.id, state: undefined }]);
  assert.equal(await service.projects.find(project.id), undefined);
  // Every Thread's deletion is published before the Project's own.
  assert.deepEqual(
    harness.notices
      .filter(
        ({ kind }) => kind === 'threadDeleted' || kind === 'projectDeleted',
      )
      .map((notice) => notice.kind),
    ['threadDeleted', 'projectDeleted'],
  );
  assert.ok(
    harness.notices.some(
      (notice) =>
        notice.kind === 'threadDeleted' && notice.threadId === thread.id,
    ),
  );
  await harness.dispose();
});

void test('a Project that is not terminal refuses deletion', async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  assert.equal(await harness.service.projects.delete(project.id), 'active');
  assert.equal(await harness.service.projects.delete(randomUUID()), 'missing');
  assert.deepEqual(harness.sandbox.discarded, []);
  await harness.dispose();
});

void test('a workspace discard that fails never fails the deletion', {
  timeout: 5000,
}, async () => {
  const harness = createHarness({
    sandbox: {
      discard: async () => {
        throw new Error('discard failed');
      },
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  await service.projects.terminate(project.id);
  await harness.projectState(project.id, 'cancelled');

  assert.equal(await service.projects.delete(project.id), 'deleted');
  assert.equal(await service.projects.find(project.id), undefined);
  assert.ok(
    harness.logs.some(
      ({ level, message }) =>
        level === 'error' && message === 'Project workspace discard failed',
    ),
  );
  await harness.dispose();
});

void test('terminating a Thread of a Project with no runtime cancels it durably', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const first = host(backend, { sandbox: { sandbox: fakeSandbox() as never } });
  const project = await first.readyProject();
  const root = await first.createThread(project.id);
  const child = await first.createThread(project.id, root.id);
  const sibling = await first.createThread(project.id);
  await first.dispose();

  // A second host over the same durable records: no runtime until something
  // prompts the Project, and terminate must not need one to have an effect.
  const second = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const terminated = await second.service.threads.terminate(root.id);
  assert.equal(terminated?.state, 'cancelled');
  for (const thread of [root, child]) {
    assert.equal(
      (await second.service.threads.find(thread.id))?.state,
      'cancelled',
    );
  }
  assert.equal((await second.service.threads.find(sibling.id))?.state, 'ready');
  // The durable subtree is terminal, so deleting it works exactly as after a
  // live termination, and termination never acquired a sandbox.
  assert.equal(await second.service.threads.delete(root.id), 'deleted');
  assert.equal(await second.service.threads.find(child.id), undefined);
  assert.equal(second.sandbox.acquired.length, 0);
  await second.dispose();
  await backend.close();
});

void test('two prompts that arrive together keep arrival order on resume', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    threads: [created],
  } = await stoppedProject(backend);
  await first.dispose();

  const gate = deferred();
  const order: string[] = [];
  const done = deferred();
  const second = host(backend, {
    sandbox: {
      acquire: async () => {
        await gate.promise;
        return {
          sandbox: fakeSandbox(),
          release: async () => undefined,
        } as never;
      },
    },
    execute: async ({ job }) => {
      order.push(job.prompt);
      if (order.length === 2) done.resolve();
      return 'done';
    },
  });
  const one = second.service.threads.prompt(created.id, 'first');
  // Let the first prompt reach its in-flight acquisition before the second
  // arrives, so the two must keep the order they arrived in.
  await second.waitFor(() => second.sandbox.acquired.length === 1);
  const two = second.service.threads.prompt(created.id, 'second');
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  const results = await Promise.all([one, two]);
  for (const result of results) assert.equal(result.status, 'accepted');
  await done.promise;
  assert.deepEqual(order, ['first', 'second']);
  await second.dispose();
  await backend.close();
});

void test('a probe that cannot run keeps every stored directory and still acquires', {
  timeout: 5000,
}, async () => {
  for (const probe of [
    { name: 'a non-zero shell exit', throwing: false },
    { name: 'a transient provider failure', throwing: true },
  ]) {
    const backend = memoryBackend();
    const {
      first,
      project,
      threads: [created],
    } = await stoppedProject(backend);
    await first.stores.threads.setCwd(created.id, '/workspace/keep', 'git');
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
    const second = host(backend, { sandbox: { sandbox: sandbox as never } });
    assert.equal(
      (await second.service.threads.prompt(created.id, 'run')).status,
      'accepted',
      probe.name,
    );
    // A probe that proves nothing leaves the record alone and the acquisition
    // becomes ready instead of failing over it.
    const record = await second.service.threads.find(created.id);
    assert.equal(record?.cwd, '/workspace/keep', probe.name);
    assert.equal(record?.cwdRepo, 'git', probe.name);
    assert.equal(
      (await second.service.projects.find(project.id))?.state,
      'ready',
      probe.name,
    );
    await second.dispose();
    await backend.close();
  }
});

void test('a working directory path containing a newline survives reacquisition', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const {
    first,
    threads: [created],
  } = await stoppedProject(backend);
  const path = '/workspace/a\nb';
  await first.stores.threads.setCwd(created.id, path, 'git');
  await first.dispose();

  const second = host(backend, {
    sandbox: {
      sandbox: fakeSandbox({ entries: [{ path: 'a\nb' }] }) as never,
    },
  });
  assert.equal(
    (await second.service.threads.prompt(created.id, 'run')).status,
    'accepted',
  );
  // The directory is still held, so a path the delimiter protocol would have
  // split in two keeps its directory instead of resetting to the root.
  assert.equal((await second.service.threads.find(created.id))?.cwd, path);
  await second.dispose();
  await backend.close();
});

void test('terminating after disposal began never adds a runtime', {
  timeout: 5000,
}, async () => {
  const backend = memoryBackend();
  const { first, project } = await stoppedProject(backend);
  await first.dispose();

  const second = host(backend, {
    sandbox: { sandbox: fakeSandbox() as never },
  });
  await second.service.dispose();
  // Shutdown owns the Project now: a termination arriving after disposal began
  // must not build a runtime and persist `cancelled` behind the suspender's
  // back, so it neither moves the Project nor acquires.
  const terminated = await second.service.projects.terminate(project.id);
  assert.equal(terminated?.state, 'queued');
  assert.equal(
    (await second.service.projects.find(project.id))?.state,
    'queued',
  );
  assert.equal(second.sandbox.acquired.length, 0);
  await second.dispose();
  await backend.close();
});

void test('a second dispose is idempotent and a disposed runtime refuses new Projects', async () => {
  const harness = createHarness();
  await harness.readyProject();
  await harness.service.dispose();
  await harness.service.dispose();
  assert.equal(harness.sandbox.released, 1);
  await assert.rejects(harness.service.projects.create('Late'), {
    message: 'Doric is shutting down.',
  });
  await harness.dispose();
});
