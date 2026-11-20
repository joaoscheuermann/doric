import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadEvent } from '../../src/contracts/model.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred, type Harness } from './support/harness.js';

/*
 * What stopping a prompt does to the work it runs, on the runtime's side
 * (bundle isolation 7(c), O14): the runtime-side behaviours the terminal
 * session tests proved through the `terminal` bundle's host, stated through
 * the runtime contracts alone. The sessions themselves are the terminal
 * bundle's, and its own tests close them on `onThreadsClosingHook`.
 */

/** Every event the Thread's log holds now. */
const logOf = async (harness: Harness, id: string): Promise<ThreadEvent[]> => [
  ...((await harness.service.threads.events(id, 0))?.events ?? []),
];

/**
 * A foreground tool call, as an executor makes it: it carries the prompt's
 * signal and runs until that signal aborts it.
 */
const foregroundCall = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, fail) => {
    signal?.addEventListener('abort', () => fail(signal.reason), {
      once: true,
    });
  });

void test('an interrupt aborts the foreground tool call of the prompt it stops', {
  timeout: 10_000,
}, async () => {
  const started = deferred();
  const aborted = deferred();
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ signal }) => {
      started.resolve();
      try {
        await foregroundCall(signal);
      } finally {
        aborted.resolve();
      }
      return 'finished';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const prompt = await harness.service.threads.prompt(thread.id, 'Run');
    if (prompt.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;

    assert.equal(
      await harness.service.threads.interrupt(thread.id, prompt.promptId),
      'interrupted',
    );

    await aborted.promise;
    await harness.threadState(thread.id, 'ready');
    const finished = (await logOf(harness, thread.id)).find(
      (event) =>
        event.promptId === prompt.promptId && event.type === 'prompt.finished',
    );
    assert.deepEqual(
      {
        status: (finished?.event as { status?: string } | undefined)?.status,
        reason: (finished?.event as { reason?: string } | undefined)?.reason,
      },
      { status: 'cancelled', reason: 'interrupted' },
    );
  } finally {
    await harness.dispose();
  }
});

void test('a host stop fires onThreadsClosingHook for the Threads it suspends', {
  timeout: 10_000,
}, async () => {
  const started = deferred();
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ signal }) => {
      started.resolve();
      await foregroundCall(signal);
      return 'finished';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const idle = await harness.createThread(project.id);
    await harness.service.threads.prompt(thread.id, 'Run');
    await started.promise;

    await harness.service.dispose();

    const closing = harness.hooks.filter(
      ({ hook }) => hook === 'onThreadsClosingHook',
    );
    // The suspended Thread is closed for the bundles that keep work for it,
    // and it is left ready to be taken up again, as the idle Thread is.
    assert.ok(
      closing.some(({ input }) =>
        (input as { threadIds: readonly string[] }).threadIds.includes(
          thread.id,
        ),
      ),
    );
    assert.ok(
      closing.every(
        ({ input }) =>
          (input as { projectId: string }).projectId === project.id,
      ),
    );
    assert.equal(
      (await harness.service.threads.find(thread.id))?.state,
      'ready',
    );
    assert.equal((await harness.service.threads.find(idle.id))?.state, 'ready');
  } finally {
    await harness.dispose();
  }
});
