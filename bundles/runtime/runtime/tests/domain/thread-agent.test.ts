import assert from 'node:assert/strict';
import test from 'node:test';

import { isContractError } from 'bundle/contracts';

import type { Thread } from '../../src/contracts/model.js';
import type {
  RuntimeThreads,
  SpawnedThread,
  SpawnOptions,
} from '../../src/contracts/threads.js';
import { memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred, type HarnessRun } from './support/harness.js';

/*
 * DORIC-71: `thread-spawn` takes an agent, a model and an effort for the
 * child. The child's runs carry them on `thread` — the agent with its
 * instructions, which travel only to the executor — and the public Thread
 * shows the agent's name and source, the model and the effort. A child spawned
 * without a model or an effort takes its parent's; an agent is never inherited.
 * The values belong to the child: a retry, a send, a restart or the next boot
 * run it with the same ones.
 */

const instructions = 'I'.repeat(64_000);

const reviewer: SpawnOptions = {
  agent: { name: 'reviewer', source: 'workspace', instructions },
  model: 'm-1',
  effort: 'high',
};

/** Every run the executor received, with the Thread it was given. */
const recorder = () => {
  const runs: { readonly prompt: string; readonly thread: Thread }[] = [];
  return {
    record: ({ job, thread }: HarnessRun) => {
      runs.push({ prompt: job.prompt, thread });
    },
    /** The runs of one Thread, oldest first. */
    of: (threadId: string) =>
      runs.filter(({ thread }) => thread.id === threadId),
  };
};

/** Asserts a Thread carries none of the spawn's three fields. */
const assertBare = (thread: Thread | undefined, what: string) => {
  assert.ok(thread !== undefined, `${what} exists`);
  assert.equal('agent' in thread, false, `${what} has no agent`);
  assert.equal('model' in thread, false, `${what} has no model`);
  assert.equal('effort' in thread, false, `${what} has no effort`);
};

/** Asserts a run was given the reviewer exactly as it was spawned. */
const assertRunsAsReviewer = (thread: Thread | undefined) => {
  assert.ok(thread !== undefined, 'the child ran');
  assert.deepEqual(thread.agent, {
    name: 'reviewer',
    source: 'workspace',
    instructions,
  });
  assert.equal(thread.model, 'm-1');
  assert.equal(thread.effort, 'high');
};

/**
 * Settles `target` with `work`, so a refused call — a contract refuses its
 * input synchronously — fails the case at once instead of timing it out.
 */
const settle = <T>(
  target: { resolve(value: T): void; reject(error: unknown): void },
  work: () => Promise<T>,
): Promise<void> =>
  Promise.resolve().then(work).then(target.resolve, target.reject);

/** Calls `spawn` with options the types refuse, as a tool's JSON would. */
const spawnUnchecked = (
  threads: RuntimeThreads,
  options: unknown,
): Promise<SpawnedThread> =>
  Promise.resolve().then(() =>
    Reflect.apply(threads.spawn, threads, ['task', undefined, options]),
  );

/** Whether `reason` is the input validation of spawn's options argument. */
const refusedOptions = (reason: unknown): boolean => {
  if (!isContractError(reason) || reason.code !== 'invalid_input') return false;
  const { issues } = (reason.details ?? {}) as {
    readonly issues?: readonly { readonly path: readonly unknown[] }[];
  };
  return issues?.some(({ path }) => path[0] === 2) ?? false;
};

void test('a child spawned without options under a bare parent runs and reads with no agent, model or effort', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const spawned = deferred<SpawnedThread>();
  const harness = createHarness({
    execute: async (run) => {
      runs.record(run);
      if (run.job.prompt === 'parent')
        await settle(spawned, () => run.tools.threads.spawn('task'));
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'parent');
  const { threadId } = await spawned.promise;
  await harness.waitFor(() => runs.of(threadId).length === 1, 'the child run');

  assertBare(runs.of(threadId)[0]?.thread, 'the child run');
  assertBare(await service.threads.find(threadId), 'the public child');
  await harness.dispose();
});

void test('a child spawned with an agent, a model and an effort runs with all three and shows them without the instructions', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const spawned = deferred<SpawnedThread>();
  const harness = createHarness({
    execute: async (run) => {
      runs.record(run);
      if (run.job.prompt === 'parent')
        await settle(spawned, () =>
          run.tools.threads.spawn('review', undefined, reviewer),
        );
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'parent');
  const { threadId } = await spawned.promise;
  await harness.waitFor(() => runs.of(threadId).length === 1, 'the child run');

  assertRunsAsReviewer(runs.of(threadId)[0]?.thread);

  const found = await service.threads.find(threadId);
  assert.deepEqual(found?.agent, { name: 'reviewer', source: 'workspace' });
  assert.equal(found?.model, 'm-1');
  assert.equal(found?.effort, 'high');
  const listed = (await service.threads.list(project.id, 10))?.items.find(
    ({ id }) => id === threadId,
  );
  assert.deepEqual(listed?.agent, { name: 'reviewer', source: 'workspace' });
  for (const thread of [found, listed])
    assert.equal(
      JSON.stringify(thread).includes('"instructions"'),
      false,
      'the public Thread never carries the instructions',
    );
  await harness.dispose();
});

void test('a retry after the host restarts runs the child with the agent, model and effort it was spawned with', {
  timeout: 15_000,
}, async () => {
  const backend = memoryBackend();
  const firstRuns = recorder();
  const spawned = deferred<SpawnedThread>();
  const first = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async (run) => {
      firstRuns.record(run);
      if (run.job.prompt === 'parent')
        await settle(spawned, () =>
          run.tools.threads.spawn('review', undefined, reviewer),
        );
      return 'done';
    },
  });
  const project = await first.readyProject();
  const parent = await first.createThread(project.id);
  await first.service.threads.prompt(parent.id, 'parent');
  const { threadId } = await spawned.promise;
  await first.waitFor(
    () => firstRuns.of(threadId).length === 1,
    'the child run',
  );
  await first.threadState(threadId, 'ready');
  await first.threadState(parent.id, 'ready');
  await first.dispose();

  // The next boot, over the same durable records.
  const secondRuns = recorder();
  const second = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async (run) => {
      secondRuns.record(run);
      return 'done';
    },
  });
  const retried = await second.service.threads.retry(threadId);
  assert.equal(retried.status, 'accepted');
  await second.waitFor(
    () => secondRuns.of(threadId).length === 1,
    'the retried child run',
  );

  assertRunsAsReviewer(secondRuns.of(threadId)[0]?.thread);
  await second.dispose();
  await backend.close();
});

void test('a parent’s send to an agent child runs it with the same agent, model and effort', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const bound = deferred<{
    readonly control: RuntimeThreads;
    readonly child: SpawnedThread;
  }>();
  const parentFinish = deferred();
  const harness = createHarness({
    execute: async (run) => {
      runs.record(run);
      if (run.job.prompt === 'parent') {
        await settle(bound, () =>
          run.tools.threads
            .spawn('review', undefined, reviewer)
            .then((child) => ({ control: run.tools.threads, child })),
        );
        await parentFinish.promise;
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'parent');
  const {
    control,
    child: { threadId },
  } = await bound.promise;
  await harness.waitFor(() => runs.of(threadId).length === 1, 'the child run');

  assert.equal((await control.send(threadId, 'more')).status, 'accepted');
  await harness.waitFor(
    () => runs.of(threadId).some(({ prompt }) => prompt === 'more'),
    'the sent prompt to run',
  );

  assertRunsAsReviewer(
    runs.of(threadId).find(({ prompt }) => prompt === 'more')?.thread,
  );
  parentFinish.resolve();
  await harness.dispose();
});

void test('a parent’s restart of a failed agent child runs it with the same agent, model and effort', {
  timeout: 15_000,
}, async () => {
  const runs = recorder();
  const bound = deferred<{
    readonly control: RuntimeThreads;
    readonly child: SpawnedThread;
  }>();
  const parentFinish = deferred();
  let failures = 0;
  const harness = createHarness({
    execute: async (run) => {
      runs.record(run);
      if (run.job.prompt === 'parent') {
        await settle(bound, () =>
          run.tools.threads
            .spawn('review', undefined, reviewer)
            .then((child) => ({ control: run.tools.threads, child })),
        );
        await parentFinish.promise;
        return 'parent done';
      }
      // The child's first run fails; the restarted one completes.
      if (failures === 0) {
        failures += 1;
        throw new Error('provider exploded');
      }
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'parent');
  const {
    control,
    child: { threadId },
  } = await bound.promise;
  await harness.waitFor(() => failures === 1, 'the child run to fail');
  await harness.threadState(threadId, 'ready');
  // The Thread failure restart reopens, as a terminal result never delivered.
  await service.threads.failTerminalResult(threadId);
  await harness.threadState(threadId, 'failed');

  const restarted = await control.restart(threadId);
  assert.equal(restarted.status, 'accepted');
  await harness.waitFor(
    () => runs.of(threadId).length === 2,
    'the restarted child run',
  );

  assertRunsAsReviewer(runs.of(threadId)[1]?.thread);
  parentFinish.resolve();
  await harness.dispose();
});

void test('refuses spawn options outside the strict schema and opens no Thread for them', {
  timeout: 10_000,
}, async () => {
  const invalid: readonly (readonly [string, unknown])[] = [
    ['an extra top-level key', { model: 'm-1', temperature: 0.2 }],
    [
      'an extra key inside the agent',
      {
        agent: {
          name: 'reviewer',
          source: 'workspace',
          instructions: 'Review.',
          tools: ['read'],
        },
      },
    ],
    ['an unknown effort', { effort: 'extreme' }],
    [
      'instructions one character over the limit',
      {
        agent: {
          name: 'reviewer',
          source: 'workspace',
          instructions: 'I'.repeat(64_001),
        },
      },
    ],
  ];
  const outcomes = deferred<{
    readonly refusals: readonly PromiseSettledResult<SpawnedThread>[];
    readonly childrenAfterRefusals: number;
    readonly valid: SpawnedThread;
  }>();
  const harness = createHarness({
    execute: async ({ job, tools }) => {
      if (job.prompt !== 'parent') return 'done';
      const refusals: PromiseSettledResult<SpawnedThread>[] = [];
      for (const [, options] of invalid)
        refusals.push(
          ...(await Promise.allSettled([
            spawnUnchecked(tools.threads, options),
          ])),
        );
      const childrenAfterRefusals = (await tools.threads.list(10)).items.length;
      // The same call with valid options is accepted: the refusals above
      // come from the options, not from the call.
      await settle(outcomes, () =>
        tools.threads
          .spawn('task', undefined, { effort: 'high' })
          .then((valid) => ({ refusals, childrenAfterRefusals, valid })),
      );
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await service.threads.prompt(parent.id, 'parent');
  const { refusals, childrenAfterRefusals, valid } = await outcomes.promise;

  invalid.forEach(([what], index) => {
    const outcome = refusals[index];
    assert.equal(outcome?.status, 'rejected', `${what} is refused`);
    assert.ok(
      outcome?.status === 'rejected' && refusedOptions(outcome.reason),
      `${what} is refused by the options schema`,
    );
  });
  assert.equal(childrenAfterRefusals, 0);
  assert.deepEqual(
    (await service.threads.list(project.id, 10))?.items
      .map(({ id }) => id)
      .sort(),
    [parent.id, valid.threadId].sort(),
  );
  await harness.dispose();
});

void test('a grandchild takes its parent’s model and effort unless it names its own, and never its agent', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const children = deferred<{
    readonly a: SpawnedThread;
    readonly b: SpawnedThread;
  }>();
  const harness = createHarness({
    execute: async (run) => {
      runs.record(run);
      const { prompt } = run.job;
      const { threads } = run.tools;
      if (prompt === 'root')
        await Promise.resolve()
          .then(() =>
            threads.spawn('coordinate', undefined, {
              model: 'm-1',
              effort: 'low',
              agent: {
                name: 'coordinator',
                source: 'built-in',
                instructions: 'Coordinate.',
              },
            }),
          )
          .catch(children.reject);
      if (prompt === 'coordinate')
        await settle(children, async () => ({
          a: await threads.spawn('child a'),
          b: await threads.spawn('child b', undefined, { model: 'm-2' }),
        }));
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const root = await harness.createThread(project.id);
  await service.threads.prompt(root.id, 'root');
  const { a, b } = await children.promise;
  await harness.waitFor(
    () => runs.of(a.threadId).length === 1 && runs.of(b.threadId).length === 1,
    'both grandchildren to run',
  );

  const expected = [
    { id: a.threadId, model: 'm-1' },
    { id: b.threadId, model: 'm-2' },
  ];
  for (const { id, model } of expected) {
    const ran = runs.of(id)[0]?.thread;
    const found = await service.threads.find(id);
    for (const thread of [ran, found]) {
      assert.equal(thread?.model, model);
      assert.equal(thread?.effort, 'low');
      assert.equal(thread !== undefined && 'agent' in thread, false);
    }
  }
  await harness.dispose();
});
