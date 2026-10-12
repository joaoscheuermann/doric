import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import { RuntimeUsageV1 } from '../../src/contracts/usage.js';
import type { ThreadContext } from '../../src/contracts/workspace.js';
import {
  createHarness,
  defaultConfiguration,
  deferred,
} from '../domain/support/harness.js';

/*
 * The stage-10 host contract additions (WP-10R): runtime.lease/v1 withLease
 * (R-5.1), runtime.workspace/v1 withThread (R-5.2), runtime.threads/v1
 * terminal result delivery (R-5.3), runtime.hooks/v1 onThreadsClosingHook
 * (R-5.4) and runtime.usage/v1 (R-5.5), each called through its contract
 * from a consumer bundle, as the terminal, git, files and usage bundles will.
 */

void test('withLease runs the task on the Project lease and answers why it cannot otherwise', {
  timeout: 5000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const ready = await harness.service.projects.withLease(
    project.id,
    async (sandbox) => `ran on ${sandbox.id}`,
  );
  assert.deepEqual(ready, { status: 'ready', value: 'ran on vm-1' });

  assert.deepEqual(
    await harness.service.projects.withLease(
      '00000000-0000-4000-8000-000000000000',
      async () => 'never',
    ),
    { status: 'missing' },
  );

  await harness.service.projects.terminate(project.id);
  await harness.projectState(project.id, 'cancelled');
  let ran = false;
  const ended = await harness.service.projects.withLease(
    project.id,
    async () => {
      ran = true;
    },
  );
  assert.equal(ended.status, 'expired');
  assert.equal(ran, false);
  await harness.dispose();
});

void test('withLease needs a Project scope', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.lease({}).withLease(async () => 'never'),
    (error: Error & { code?: string }) => error.code === 'invalid_input',
  );
  await harness.dispose();
});

void test('withThread hands the task the live Thread, and refuses missing or ended ones', {
  timeout: 5000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  let seen: ThreadContext | undefined;
  const ready = await harness.service.threads.withThread(
    thread.id,
    { exclusive: false },
    async (context) => {
      seen = context;
      return context.closing();
    },
  );
  assert.deepEqual(ready, { status: 'ready', value: false });
  assert.equal(seen?.projectId, project.id);
  assert.equal(seen?.threadId, thread.id);
  assert.equal(seen?.cwd, thread.cwd);
  assert.deepEqual(seen?.busyCwds(), []);

  assert.deepEqual(
    await harness.service.threads.withThread(
      '00000000-0000-4000-8000-000000000000',
      { exclusive: false },
      async () => 'never',
    ),
    { status: 'missing' },
  );

  await harness.service.threads.terminate(thread.id);
  await harness.threadState(thread.id, 'cancelled');
  assert.deepEqual(
    await harness.service.threads.withThread(
      thread.id,
      { exclusive: true },
      async () => 'never',
    ),
    { status: 'inactive' },
  );
  // The closing() the task kept now reports the ended Thread.
  assert.equal(seen?.closing(), true);
  await harness.dispose();
});

void test('withThread lists the cwds of Threads with running work', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const finish = deferred();
  const harness = createHarness({
    execute: async () => {
      started.resolve();
      await finish.promise;
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const busy = await harness.createThread(project.id);
  const idle = await harness.createThread(project.id);
  await harness.service.threads.prompt(busy.id, 'hold');
  await started.promise;
  const outcome = await harness.service.threads.withThread(
    idle.id,
    { exclusive: false },
    async (context) => context.busyCwds(),
  );
  assert.deepEqual(outcome, { status: 'ready', value: [busy.cwd] });
  finish.resolve();
  await harness.dispose();
});

void test('an exclusive withThread task holds the Project mutation lock', {
  timeout: 5000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const inside = deferred();
  const release = deferred();
  const task = harness.service.threads.withThread(
    thread.id,
    { exclusive: true },
    async () => {
      inside.resolve();
      await release.promise;
      return 'held';
    },
  );
  await inside.promise;
  let renamed = false;
  const rename = harness.service.threads
    .rename(thread.id, 'Renamed')
    .then((value) => {
      renamed = true;
      return value;
    });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(renamed, false);
  release.resolve();
  assert.deepEqual(await task, { status: 'ready', value: 'held' });
  assert.equal((await rename)?.name, 'Renamed');
  await harness.dispose();
});

void test('a terminal result is enqueued to its Thread as a redacted terminal prompt', {
  timeout: 5000,
}, async () => {
  const delivered = deferred<{ prompt: string; source: unknown }>();
  const harness = createHarness({
    credentials: () => [
      { id: 'c1', kind: 'API_TOKEN', name: 'Key', secret: 'secret-value' },
    ],
    execute: async ({ job }) => {
      if (job.source.kind === 'terminal')
        delivered.resolve({ prompt: job.prompt, source: job.source });
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.terminalResult({
    threadId: thread.id,
    promptId: 'p-1',
    terminalId: 't-1',
    text: '# Background terminal result\n\nprinted secret-value',
  });
  const { prompt, source } = await delivered.promise;
  assert.doesNotMatch(prompt, /secret-value/u);
  assert.match(prompt, /printed \[REDACTED\]/u);
  assert.deepEqual(source, {
    kind: 'terminal',
    terminalId: 't-1',
    promptId: 'p-1',
  });
  await harness.dispose();
});

void test('a terminal result for a closed Thread is dropped', {
  timeout: 5000,
}, async () => {
  let terminalRuns = 0;
  const harness = createHarness({
    execute: async ({ job }) => {
      if (job.source.kind === 'terminal') terminalRuns += 1;
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.terminate(thread.id);
  await harness.threadState(thread.id, 'cancelled');
  await harness.service.threads.terminalResult({
    threadId: thread.id,
    promptId: 'p-1',
    terminalId: 't-1',
    text: 'late',
  });
  assert.equal(terminalRuns, 0);
  assert.equal(
    harness.logs.some(
      ({ message }) => message === 'Terminal result delivery failed',
    ),
    false,
  );
  await harness.dispose();
});

void test('a failed terminal result is logged and closes its Thread', {
  timeout: 5000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.failTerminalResult(thread.id);
  assert.deepEqual(
    harness.logs.find(
      ({ message }) => message === 'Terminal result delivery failed',
    ),
    {
      level: 'error',
      message: 'Terminal result delivery failed',
      fields: { threadId: thread.id },
    },
  );
  await harness.waitFor(
    async () =>
      (await harness.stores.threads.record(thread.id))?.errorCode ===
      'terminal_result_failed',
    'the terminal_result_failed close',
  );
  await harness.dispose();
});

void test('closing Threads fires onThreadsClosingHook with their ids', {
  timeout: 5000,
}, async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.terminate(thread.id);
  await harness.threadState(thread.id, 'cancelled');
  assert.deepEqual(
    harness.hooks.filter(({ hook }) => hook === 'onThreadsClosingHook'),
    [
      {
        hook: 'onThreadsClosingHook',
        input: { projectId: project.id, threadIds: [thread.id] },
      },
    ],
  );
  await harness.dispose();
});

void test('runtime.usage/v1 reads the stored projection without the capacity fill', {
  timeout: 5000,
}, async () => {
  const configuration: ConfigurationValue = {
    ...defaultConfiguration,
    providers: [
      {
        id: 'router',
        kind: 'openrouter',
        configuration: {},
        models: [{ name: 'measured' }],
      },
    ],
  };
  const harness = createHarness({
    configuration: () => ({
      configuration,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }),
    models: {
      router: {
        models: async () => [{ id: 'measured', contextWindow: 200000 }],
      },
    },
    execute: async ({ session }) => {
      await session.record({
        event: {
          type: 'response.started',
          provider: 'openrouter',
          model: 'measured',
          providerId: 'router',
        },
      });
      return 'done';
    },
  });
  const usage = harness.consumer.services.use(RuntimeUsageV1);
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.prompt(thread.id, 'measure');
  await harness.waitFor(
    async () =>
      (await harness.service.threads.find(thread.id))?.result !== undefined,
  );
  const stored = await usage.read(thread.id);
  assert.deepEqual(stored?.context, {
    model: 'measured',
    providerId: 'router',
  });
  assert.equal(
    (await harness.service.threads.usage(thread.id))?.context?.contextWindow,
    200000,
  );
  assert.equal(
    await usage.read('00000000-0000-4000-8000-000000000000'),
    undefined,
  );
  await harness.dispose();
});
