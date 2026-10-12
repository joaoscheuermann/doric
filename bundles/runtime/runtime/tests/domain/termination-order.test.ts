import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, deferred } from './support/harness.js';

/*
 * Terminating a Thread whose prompt is mid-response records the prompt's
 * cancellation before the queue change and the prompt's end, as agents/doric
 * did: agent.cancelled, queue.updated, prompt.finished. The executor's abort
 * may cross a process boundary, so its rejection arrives late here.
 */

const terminated = async (
  terminate: (
    harness: ReturnType<typeof createHarness>,
    ids: { project: string; thread: string },
  ) => Promise<unknown>,
) => {
  const started = deferred();
  const harness = createHarness({
    execute: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      // The abort settles the executor only after a delay, as over IPC.
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('aborted');
    },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const accepted = await harness.service.threads.prompt(thread.id, 'work');
  assert.ok(accepted.status === 'accepted');
  await started.promise;

  await terminate(harness, { project: project.id, thread: thread.id });
  await harness.threadState(thread.id, 'cancelled');

  const history = await harness.service.threads.events(thread.id, 0);
  const tail = (history?.events ?? [])
    .filter(({ promptId }) => promptId === accepted.promptId)
    .map(({ type }) => type)
    .filter((type) =>
      ['agent.cancelled', 'queue.updated', 'prompt.finished'].includes(type),
    );
  const finished = history?.events.find(
    ({ promptId, type }) =>
      promptId === accepted.promptId && type === 'prompt.finished',
  );
  await harness.dispose();
  return { tail, finished };
};

void test('thread termination records the cancellation before the queue change', {
  timeout: 10_000,
}, async () => {
  const { tail, finished } = await terminated((harness, { thread }) =>
    harness.service.threads.terminate(thread),
  );

  // queue.updated also opens the run; only the order after it matters.
  assert.deepEqual(tail.slice(-3), [
    'agent.cancelled',
    'queue.updated',
    'prompt.finished',
  ]);
  assert.equal(
    (finished?.event as { status?: string } | undefined)?.status,
    'cancelled',
  );
});

void test('project termination records the cancellation before the queue change', {
  timeout: 10_000,
}, async () => {
  const { tail } = await terminated((harness, { project }) =>
    harness.service.projects.terminate(project),
  );

  assert.deepEqual(tail.slice(-3), [
    'agent.cancelled',
    'queue.updated',
    'prompt.finished',
  ]);
});
