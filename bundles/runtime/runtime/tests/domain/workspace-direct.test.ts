import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, deferred } from './support/harness.js';

/*
 * The runner half of agents/doric tests/workspace-direct.test.ts (design 57
 * §13.2): a persistence failure the executor meets through its
 * PromptSession fails the Thread closed, so no later prompt runs on stale
 * history. The Direct half (real tools and provider) is the direct bundle's.
 */

void test('stops queued execution when the executor cannot persist its resulting history', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const release = deferred();
  let invocations = 0;
  let failSave = true;
  const harness = createHarness({
    execute: async ({ append }) => {
      invocations += 1;
      started.resolve();
      await release.promise;
      await append({ role: 'assistant', content: 'Result with effects.' });
      return 'Result with effects already performed.';
    },
  });
  const { service } = harness;
  const saveHistory = harness.stores.threads.saveHistory;
  harness.stores.threads.saveHistory = async (id, patch) => {
    if (failSave) {
      failSave = false;
      throw new Error('database unavailable');
    }
    await saveHistory(id, patch);
  };
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.ok(created.status === 'created');
  await service.threads.prompt(created.thread.id, 'first');
  await started.promise;
  await service.threads.prompt(
    created.thread.id,
    'must not run with stale history',
  );
  release.resolve();
  await harness.threadState(created.thread.id, 'failed');
  assert.equal(invocations, 1);
  assert.equal(
    (await service.threads.prompt(created.thread.id, 'retry')).status,
    'inactive',
  );
  assert.equal(
    (await service.threads.find(created.thread.id))?.errorCode,
    'persistence_failed',
  );
  await harness.dispose();
});

void test('releases the sandbox despite transient cancellation persistence failures', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  let rejectProject = true;
  let rejectThread = true;
  const harness = createHarness({
    execute: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return 'cancelled';
    },
  });
  const { service } = harness;
  const projectState = harness.stores.projects.setState;
  harness.stores.projects.setState = async (id, state, code) => {
    if (state === 'cancelling' && rejectProject) {
      rejectProject = false;
      throw new Error('database unavailable');
    }
    return projectState(id, state, code);
  };
  const threadState = harness.stores.threads.setState;
  harness.stores.threads.setState = async (id, state, promptId, code) => {
    if (state === 'cancelling' && rejectThread) {
      rejectThread = false;
      throw new Error('database unavailable');
    }
    return threadState(id, state, promptId, code);
  };
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.ok(created.status === 'created');
  await service.threads.prompt(created.thread.id, 'work');
  await started.promise;
  await service.threads.prompt(created.thread.id, 'queued');
  await service.projects.terminate(project.id);
  await service.dispose();
  assert.equal(harness.sandbox.released, 1);
  assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
  assert.equal(
    (await service.threads.find(created.thread.id))?.state,
    'cancelled',
  );
  await harness.dispose();
});

void test('fails closed when the executor cannot persist a streamed event after queued acceptance', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const finishExecution = deferred();
  const laterExecution = deferred();
  let failEvent = false;
  let executions = 0;
  const harness = createHarness({
    execute: async ({ session }) => {
      executions += 1;
      if (executions > 1) laterExecution.resolve();
      started.resolve();
      await finishExecution.promise;
      await session.record({
        event: { type: 'agent.finished', response: { text: 'durable' } },
      });
      return 'Result whose streamed event must be durable.';
    },
  });
  const { service } = harness;
  const appendEvent = harness.stores.threads.appendEvent;
  harness.stores.threads.appendEvent = async (id, promptId, event) => {
    if (failEvent) {
      failEvent = false;
      throw new Error('event storage unavailable');
    }
    return appendEvent(id, promptId, event);
  };
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.ok(created.status === 'created');
  await service.threads.prompt(created.thread.id, 'first');
  await started.promise;
  assert.equal(
    (await service.threads.prompt(created.thread.id, 'queued')).status,
    'accepted',
  );
  failEvent = true;
  finishExecution.resolve();
  await Promise.race([
    harness.threadState(created.thread.id, 'failed'),
    laterExecution.promise,
  ]);
  assert.equal(
    (await service.threads.find(created.thread.id))?.state,
    'failed',
  );
  assert.equal(
    (await service.threads.prompt(created.thread.id, 'retry')).status,
    'inactive',
  );
  await service.dispose();
  assert.equal(executions, 1);
  await harness.dispose();
});

void test('a history format the executor does not read fails the prompt before any run', {
  timeout: 5000,
}, async () => {
  let runs = 0;
  const harness = createHarness({
    executor: { formats: ['other.history/v1'] },
    execute: async ({ append }) => {
      runs += 1;
      await append({ role: 'assistant', content: 'written' });
      return 'done';
    },
  });
  const { service } = harness;
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  // The executor's checkpoint wrote the test format, which it does not read.
  const first = await service.threads.prompt(thread.id, 'first');
  assert.ok(first.status === 'accepted');
  await harness.waitFor(
    async () => (await service.threads.find(thread.id))?.result !== undefined,
  );
  const events = (await service.threads.events(thread.id, 0))?.events ?? [];
  assert.equal(runs, 0);
  assert.deepEqual(
    events
      .filter(
        ({ type }) => type === 'agent.failed' || type === 'prompt.finished',
      )
      .map(({ type, event }) => [
        type,
        (event as { status?: string; text?: string }).status,
        (event as { text?: string }).text,
      ]),
    [
      ['agent.failed', undefined, undefined],
      ['prompt.finished', 'failed', 'The prompt failed.'],
    ],
  );
  assert.ok(
    harness.logs.some(
      ({ fields }) => fields?.code === 'history_format_unsupported',
    ),
  );
  await harness.dispose();
});
