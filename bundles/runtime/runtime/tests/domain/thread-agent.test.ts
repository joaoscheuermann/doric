import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { isContractError } from 'bundle/contracts';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import type { Thread } from '../../src/contracts/model.js';
import { createdKey } from '../../src/contracts/storage.js';
import type {
  RuntimeThreads,
  SpawnedThread,
  SpawnOptions,
} from '../../src/contracts/threads.js';
import type { ModelCatalogSource } from '../../src/host/domain/usage-context.js';
import { memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  defaultConfiguration,
  deferred,
  epoch,
  type HarnessRun,
} from './support/harness.js';

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

/**
 * models/v1 resolves the harness's one provider, so a spawn that names a
 * model or an effort passes the runtime's validation (spec §4).
 */
const openrouterModels: Readonly<Record<string, ModelCatalogSource>> = {
  openrouter: { models: async () => [] },
};

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

/**
 * Asserts a Thread carries no agent and the harness's default execution
 * (`openrouter`, `deepseek/deepseek-v4-flash-0731`, `low`).
 */
const assertDefaultExecution = (thread: Thread | undefined, what: string) => {
  assert.ok(thread !== undefined, `${what} exists`);
  assert.equal('agent' in thread, false, `${what} has no agent`);
  assert.equal(thread.providerId, 'openrouter', `${what} provider`);
  assert.equal(
    thread.model,
    'deepseek/deepseek-v4-flash-0731',
    `${what} model`,
  );
  assert.equal(thread.effort, 'low', `${what} effort`);
};

/** Asserts a Thread stores exactly this execution, an absent effort included. */
const assertExecution = (
  thread: Thread | undefined,
  expected: {
    readonly providerId: string;
    readonly model: string;
    readonly effort?: string;
  },
  what: string,
) => {
  assert.ok(thread !== undefined, `${what} exists`);
  assert.deepEqual(
    {
      providerId: thread.providerId,
      model: thread.model,
      ...('effort' in thread ? { effort: thread.effort } : {}),
    },
    expected,
    what,
  );
};

/** Asserts a run was given the reviewer exactly as it was spawned. */
const assertRunsAsReviewer = (thread: Thread | undefined) => {
  assert.ok(thread !== undefined, 'the child ran');
  assert.deepEqual(thread.agent, {
    name: 'reviewer',
    source: 'workspace',
    instructions,
  });
  assert.equal(thread.providerId, 'openrouter');
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

void test('a child spawned without options runs and reads with its parent’s provider, model and effort and no agent', {
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

  assertDefaultExecution(runs.of(threadId)[0]?.thread, 'the child run');
  assertDefaultExecution(
    await service.threads.find(threadId),
    'the public child',
  );
  await harness.dispose();
});

void test('a child spawned with an agent, a model and an effort runs with all three and shows them without the instructions', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const spawned = deferred<SpawnedThread>();
  const harness = createHarness({
    models: openrouterModels,
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
    models: openrouterModels,
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
    models: openrouterModels,
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
    models: openrouterModels,
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
    models: openrouterModels,
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

void test('a grandchild takes its parent’s provider, model and effort unless it names its own, the child of a model-only spawn starts at that model’s start effort, and none takes an agent', {
  timeout: 10_000,
}, async () => {
  const runs = recorder();
  const children = deferred<{
    readonly a: SpawnedThread;
    readonly b: SpawnedThread;
  }>();
  const harness = createHarness({
    models: openrouterModels,
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

  // The harness provider lists no models, so `m-2` has no start effort.
  const expected = [
    {
      id: a.threadId,
      execution: { providerId: 'openrouter', model: 'm-1', effort: 'low' },
    },
    { id: b.threadId, execution: { providerId: 'openrouter', model: 'm-2' } },
  ];
  for (const { id, execution } of expected) {
    const ran = runs.of(id)[0]?.thread;
    const found = await service.threads.find(id);
    for (const [what, thread] of [
      ['run', ran],
      ['record', found],
    ] as const) {
      assertExecution(thread, execution, `${id} ${what}`);
      assert.equal(thread !== undefined && 'agent' in thread, false);
    }
  }
  await harness.dispose();
});

/*
 * Per-thread model (runtime.threads/v1 1.7.0, spec §4): every new Thread
 * stores a provider, a model and an optional effort. A top-level Thread copies
 * the workspace default, a child its parent's, and a spawn completes the
 * parent's with the model and effort it names, validated before any Thread
 * exists.
 */

/** The configuration answer the harness gives on every read. */
const answering = (value: () => ConfigurationValue) => () => ({
  configuration: value(),
  revision: 1,
  updatedAt: epoch,
});

const [openrouter] = defaultConfiguration.providers;

/** The harness provider listing three models, the default on `m-1`. */
const listingConfiguration: ConfigurationValue = {
  ...defaultConfiguration,
  providers: [
    {
      ...(openrouter as NonNullable<typeof openrouter>),
      models: [
        { name: 'parent-model', reasonings: ['low', 'high'] },
        {
          name: 'other-model',
          reasonings: ['none', 'medium', 'high'],
          defaultEffort: 'none',
        },
        { name: 'm-1', reasonings: ['low'] },
      ],
    },
  ],
  models: {
    execution: { providerId: 'openrouter', model: 'm-1', effort: 'low' },
  },
};

/** The default execution with an effort host-config accepts but no model runs. */
const unknownDefaultEffort: ConfigurationValue = {
  ...defaultConfiguration,
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'turbo',
    },
  },
};

void test('T-4 a top-level Thread stores the workspace default provider, model and effort', {
  timeout: 10_000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);

  assertDefaultExecution(thread, 'the created Thread');
  assertDefaultExecution(
    await harness.service.threads.find(thread.id),
    'the public Thread',
  );
  await harness.dispose();
});

void test('T-4 a top-level Thread stores no effort when the default effort is not a reasoning effort', {
  timeout: 10_000,
}, async () => {
  const harness = createHarness({
    configuration: answering(() => unknownDefaultEffort),
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);

  const expected = {
    providerId: 'openrouter',
    model: 'deepseek/deepseek-v4-flash-0731',
  };
  assertExecution(thread, expected, 'the created Thread');
  assertExecution(
    await harness.service.threads.find(thread.id),
    expected,
    'the public Thread',
  );
  await harness.dispose();
});

void test('T-5 a reader-opened sub-thread stores its parent’s execution, also when the configuration no longer has it', {
  timeout: 10_000,
}, async () => {
  let configuration: ConfigurationValue = defaultConfiguration;
  const harness = createHarness({
    configuration: answering(() => configuration),
  });
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  // The default moves to a provider the parent's execution is not on, and
  // the parent's provider leaves the configuration.
  configuration = {
    ...defaultConfiguration,
    providers: [
      {
        ...(openrouter as NonNullable<typeof openrouter>),
        id: 'other',
      },
    ],
    models: {
      execution: { providerId: 'other', model: 'other-model', effort: 'high' },
    },
  };
  const child = await harness.createThread(project.id, parent.id);

  assertDefaultExecution(child, 'the created sub-thread');
  assertDefaultExecution(
    await harness.service.threads.find(child.id),
    'the public sub-thread',
  );
  await harness.dispose();
});

/** A Thread document as the store wrote it before runtime.thread/v1 1.2.0. */
const legacyDocument = (
  projectId: string,
  name: string,
  values: { readonly model?: string; readonly effort?: string },
) => {
  const id = randomUUID();
  return {
    type: 'runtime.thread/v1',
    id,
    value: {
      id,
      projectId,
      parentThreadId: null,
      origin: 'user',
      name,
      state: 'ready',
      open: true,
      cwd: '/workspace',
      cwdRepo: null,
      queuePaused: false,
      activePromptId: null,
      errorCode: null,
      lastSequence: 0,
      result: null,
      lastStarted: null,
      usage: null,
      pending: [],
      createdAt: epoch,
      updatedAt: epoch,
      startedAt: null,
      finishedAt: null,
      createdKey: createdKey(epoch, id),
      ...values,
    },
  };
};

void test('T-5 a sub-thread under a legacy parent stores the parent’s resolved execution with a provider', {
  timeout: 15_000,
}, async () => {
  const backend = memoryBackend();
  const first = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const project = await first.readyProject();
  await first.dispose();

  const withValues = legacyDocument(project.id, 'Legacy with values', {
    model: 'legacy-model',
    effort: 'high',
  });
  const bare = legacyDocument(project.id, 'Legacy bare', {});
  await backend.storage.commit({
    expect: [withValues, bare].map(({ id }) => ({
      type: 'runtime.thread/v1',
      id,
      revision: 0,
    })),
    put: [withValues, bare],
  });

  // The next boot loads the legacy parents; the default effort is one no
  // model runs, so a bare legacy parent passes no effort on.
  const second = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    configuration: answering(() => unknownDefaultEffort),
  });
  await second.service.recoverProjects();
  await second.projectState(project.id, 'ready');

  const fromValues = await second.createThread(project.id, withValues.id);
  const fromBare = await second.createThread(project.id, bare.id);

  const cases = [
    [
      fromValues,
      { providerId: 'openrouter', model: 'legacy-model', effort: 'high' },
    ],
    [
      fromBare,
      { providerId: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
    ],
  ] as const;
  for (const [child, expected] of cases) {
    assertExecution(child, expected, `${child.name} created`);
    assertExecution(
      await second.service.threads.find(child.id),
      expected,
      `${child.name} public`,
    );
  }
  await second.dispose();
  await backend.close();
});

void test('T-6 a spawn completes the parent’s execution with the model and effort it names', {
  timeout: 15_000,
}, async () => {
  const runs = recorder();
  const spawns: readonly (readonly [
    string,
    SpawnOptions | undefined,
    {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    },
  ])[] = [
    [
      'no options',
      undefined,
      { providerId: 'openrouter', model: 'parent-model', effort: 'high' },
    ],
    [
      'a model and an effort',
      { model: 'other-model', effort: 'none' },
      { providerId: 'openrouter', model: 'other-model', effort: 'none' },
    ],
    [
      'the parent’s model alone',
      { model: 'parent-model' },
      { providerId: 'openrouter', model: 'parent-model', effort: 'high' },
    ],
    [
      'another model alone',
      { model: 'other-model' },
      { providerId: 'openrouter', model: 'other-model', effort: 'medium' },
    ],
    [
      'an effort alone',
      { effort: 'low' },
      { providerId: 'openrouter', model: 'parent-model', effort: 'low' },
    ],
  ];
  const children = deferred<readonly SpawnedThread[]>();
  const harness = createHarness({
    configuration: answering(() => listingConfiguration),
    models: openrouterModels,
    execute: async (run) => {
      runs.record(run);
      if (run.job.prompt === 'parent')
        await settle(children, async () => {
          const spawned: SpawnedThread[] = [];
          for (const [what, options] of spawns)
            spawned.push(
              await run.tools.threads.spawn(what, undefined, options),
            );
          return spawned;
        });
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  const chosen = await service.threads.setExecution(parent.id, {
    providerId: 'openrouter',
    model: 'parent-model',
    effort: 'high',
  });
  assert.equal(chosen.status, 'updated');
  await service.threads.prompt(parent.id, 'parent');
  const spawned = await children.promise;
  await harness.waitFor(
    () => spawned.every(({ threadId }) => runs.of(threadId).length === 1),
    'every child run',
  );

  spawns.forEach(([what, , expected], index) => {
    const id = spawned[index]?.threadId ?? '';
    assertExecution(runs.of(id)[0]?.thread, expected, `${what}: run`);
  });
  for (const [index, [what, , expected]] of spawns.entries())
    assertExecution(
      await service.threads.find(spawned[index]?.threadId ?? ''),
      expected,
      `${what}: record`,
    );
  await harness.dispose();
});

/** The settled outcome of each spawn a parent's run made, in order. */
const spawnOutcomes = async (
  harness: ReturnType<typeof createHarness>,
  outcomes: Promise<readonly PromiseSettledResult<SpawnedThread>[]>,
) => {
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await harness.service.threads.prompt(parent.id, 'parent');
  const settled = await outcomes;
  const threads =
    (await harness.service.threads.list(project.id, 20))?.items.map(
      ({ id }) => id,
    ) ?? [];
  return { parent, settled, threads };
};

/** A harness whose `parent` prompt spawns once per options, settling each. */
const spawningHarness = (
  options: readonly SpawnOptions[],
  extra: Parameters<typeof createHarness>[0] = {},
) => {
  const outcomes = deferred<readonly PromiseSettledResult<SpawnedThread>[]>();
  const harness = createHarness({
    ...extra,
    execute: async ({ job, tools }) => {
      if (job.prompt !== 'parent') return 'done';
      const settled: PromiseSettledResult<SpawnedThread>[] = [];
      for (const option of options)
        settled.push(
          ...(await Promise.allSettled([
            Promise.resolve().then(() =>
              tools.threads.spawn('task', undefined, option),
            ),
          ])),
        );
      outcomes.resolve(settled);
      return 'done';
    },
  });
  return { harness, outcomes: outcomes.promise };
};

/** The `ContractError` an execution refusal rejects a spawn with. */
const refusal = (outcome: PromiseSettledResult<SpawnedThread> | undefined) => {
  assert.equal(outcome?.status, 'rejected');
  const reason = outcome?.status === 'rejected' ? outcome.reason : undefined;
  assert.ok(isContractError(reason), 'a ContractError');
  return {
    code: reason.code,
    message: reason.message,
    issue: (reason.details as { readonly issue?: unknown } | undefined)?.issue,
  };
};

void test('T-7 a spawn naming a model the provider does not list, or an effort the model does not support, is refused and creates no Thread', {
  timeout: 10_000,
}, async () => {
  const { harness, outcomes } = spawningHarness(
    [{ model: 'm-9' }, { model: 'm-1', effort: 'high' }, { effort: 'xhigh' }],
    {
      configuration: answering(() => listingConfiguration),
      models: openrouterModels,
    },
  );
  const { parent, settled, threads } = await spawnOutcomes(harness, outcomes);

  assert.deepEqual(refusal(settled[0]), {
    code: 'invalid_execution',
    message:
      'Model "m-9" is not available on provider "openrouter". Available models: parent-model, other-model, m-1.',
    issue: 'model',
  });
  assert.deepEqual(refusal(settled[1]), {
    code: 'invalid_execution',
    message:
      'Effort "high" is not supported by model "m-1". Supported efforts: low.',
    issue: 'effort',
  });
  // An effort alone is checked against the parent's model, `m-1`.
  assert.deepEqual(refusal(settled[2]), {
    code: 'invalid_execution',
    message:
      'Effort "xhigh" is not supported by model "m-1". Supported efforts: low.',
    issue: 'effort',
  });
  assert.deepEqual(threads, [parent.id]);
  await harness.dispose();
});

void test('T-7 a spawn on a parent provider the configuration no longer has is refused and creates no Thread', {
  timeout: 10_000,
}, async () => {
  let configuration: ConfigurationValue = defaultConfiguration;
  const proceed = deferred();
  const outcomes = deferred<PromiseSettledResult<SpawnedThread>>();
  const harness = createHarness({
    configuration: answering(() => configuration),
    models: openrouterModels,
    execute: async ({ job, tools }) => {
      if (job.prompt !== 'parent') return 'done';
      await proceed.promise;
      const [outcome] = await Promise.allSettled([
        Promise.resolve().then(() =>
          tools.threads.spawn('task', undefined, { model: 'm-1' }),
        ),
      ]);
      outcomes.resolve(outcome as PromiseSettledResult<SpawnedThread>);
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);
  await harness.service.threads.prompt(parent.id, 'parent');
  configuration = {
    ...defaultConfiguration,
    providers: [
      { ...(openrouter as NonNullable<typeof openrouter>), id: 'other' },
    ],
    models: { execution: { providerId: 'other', model: 'm-1' } },
  };
  proceed.resolve();

  assert.deepEqual(refusal(await outcomes.promise), {
    code: 'invalid_execution',
    message: 'Provider "openrouter" is not configured.',
    issue: 'provider',
  });
  assert.deepEqual(
    (await harness.service.threads.list(project.id, 20))?.items.map(
      ({ id }) => id,
    ),
    [parent.id],
  );
  await harness.dispose();
});

void test('T-7 a spawn on a provider models/v1 cannot resolve rejects with its error and creates no Thread', {
  timeout: 10_000,
}, async () => {
  // No `models`: the harness's models/v1.resolve refuses every provider.
  const { harness, outcomes } = spawningHarness([{ model: 'm-2' }]);
  const { parent, settled, threads } = await spawnOutcomes(harness, outcomes);

  const [outcome] = settled;
  assert.equal(outcome?.status, 'rejected');
  const reason = outcome?.status === 'rejected' ? outcome.reason : undefined;
  assert.equal(
    (reason as Error | undefined)?.message,
    'Configured provider is unavailable.',
  );
  assert.equal(
    isContractError(reason) && reason.code === 'invalid_execution',
    false,
  );
  assert.deepEqual(threads, [parent.id]);
  await harness.dispose();
});

void test('T-7 a provider whose model list is empty accepts any model a spawn names', {
  timeout: 10_000,
}, async () => {
  const { harness, outcomes } = spawningHarness([{ model: 'typed/by-hand' }], {
    models: openrouterModels,
  });
  const { settled } = await spawnOutcomes(harness, outcomes);

  const [outcome] = settled;
  assert.equal(outcome?.status, 'fulfilled');
  const child = await harness.service.threads.find(
    outcome?.status === 'fulfilled' ? outcome.value.threadId : '',
  );
  assertExecution(
    child,
    { providerId: 'openrouter', model: 'typed/by-hand' },
    'the spawned child',
  );
  await harness.dispose();
});

void test('T-8 a configuration read that rejects makes createThread and spawn reject and creates no Thread', {
  timeout: 10_000,
}, async () => {
  let offline = false;
  const outcomes = deferred<readonly PromiseSettledResult<SpawnedThread>[]>();
  const harness = createHarness({
    models: openrouterModels,
    configuration: () => {
      if (offline) throw new Error('configuration offline');
      return {
        configuration: defaultConfiguration,
        revision: 1,
        updatedAt: epoch,
      };
    },
    execute: async ({ job, tools }) => {
      if (job.prompt !== 'parent') return 'done';
      offline = true;
      const settled = await Promise.allSettled([
        Promise.resolve().then(() => tools.threads.spawn('plain')),
        Promise.resolve().then(() =>
          tools.threads.spawn('named', undefined, { model: 'm-1' }),
        ),
      ]);
      offline = false;
      outcomes.resolve(settled);
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const parent = await harness.createThread(project.id);

  offline = true;
  const created = await Promise.allSettled([
    service.threads.create(project.id, 'Top-level'),
    service.threads.create(project.id, 'Sub-thread', parent.id),
  ]);
  offline = false;
  assert.deepEqual(
    created.map(({ status }) => status),
    ['rejected', 'rejected'],
  );

  await service.threads.prompt(parent.id, 'parent');
  assert.deepEqual(
    (await outcomes.promise).map(({ status }) => status),
    ['rejected', 'rejected'],
  );
  assert.deepEqual(
    (await service.threads.list(project.id, 20))?.items.map(({ id }) => id),
    [parent.id],
  );
  await harness.dispose();
});
