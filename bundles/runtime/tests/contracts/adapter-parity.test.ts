import assert from 'node:assert/strict';
import test from 'node:test';

import type { CallScope } from 'bundle/contracts';

import { createHarness, deferred } from '../domain/support/harness.js';
import {
  type CaptureDriver,
  readTranscript,
  runScenario,
  setup,
  transcriptOf,
} from '../support/capture-adapter.js';
import { fakeSandbox } from '../support/sandbox.js';

/*
 * The adapter parity evidence (design 57 §13.1, stage 5 "Tools receive the
 * same results from runtime.threads/v1 / runtime.workspace/v1 as from the
 * adapter"): the golden transcript 57-WP-0 recorded from the stage-1
 * host-adapter, replayed against the runtime's own providers over the real
 * store, must be equal after normalization.
 */

/** The replay driver: the same environment as the kernel recording. */
const runtimeDriver = (): CaptureDriver => {
  const written = new Map<string, string>();
  const scripted = fakeSandbox(setup.sandbox);
  const sandbox = {
    ...scripted,
    readFile: async (path: string) =>
      written.get(path) ?? scripted.readFile(path),
    writeFile: async (path: string, content: string) => {
      written.set(path, content);
    },
  };
  const bound = deferred<CallScope>();
  const finished = deferred();
  let parentPrompt: string | undefined;
  const harness = createHarness({
    sandbox: { sandbox: sandbox as never },
    execute: async ({ job, scope }) => {
      if (job.prompt !== setup.parentPrompt)
        return `${setup.childResultPrefix}${job.prompt}`;
      parentPrompt = job.id;
      bound.resolve(scope);
      await finished.promise;
      return 'parent done';
    },
  });
  let parent: ReturnType<typeof harness.bindings.bound> | undefined;

  return {
    // Calls reach the runtime from a consumer bundle, as a tool's do.
    services: harness.consumer.services,
    call: (scope) => harness.consumer.call(scope),
    start: async () => {
      const project = await harness.readyProject(setup.project);
      const created = await harness.service.threads.create(
        project.id,
        setup.parentThread,
      );
      assert.ok(created.status === 'created');
      await harness.service.threads.prompt(
        created.thread.id,
        setup.parentPrompt,
      );
      const scope = await bound.promise;
      parent = harness.bindings.bound({ scope });
      return scope;
    },
    settle: (threadId, promptId) =>
      harness.waitFor(async () => {
        const thread = await harness.service.threads.find(threadId);
        const queue = await harness.service.threads.queue(threadId);
        return (
          thread?.state === 'ready' &&
          thread.activePromptId === undefined &&
          thread.result?.promptId === promptId &&
          queue?.items.length === 0
        );
      }, `Thread ${threadId}`),
    end: async () => {
      finished.resolve();
      // The binding is released once the run settled, before its finish.
      await harness.waitFor(
        () =>
          harness
            .events()
            .some(
              ({ promptId, type }) =>
                promptId === parentPrompt && type === 'prompt.finished',
            ),
        'the parent release',
      );
    },
    bindWithoutTerminals: (scope) => {
      assert.ok(parent !== undefined);
      return harness.bindings.attach(
        {
          projectId: scope.projectId as string,
          threadId: scope.threadId as string,
          promptId: scope.promptId as string,
        },
        {
          host: {
            threads: parent.host.threads,
            workspace: parent.host.workspace,
          },
          sandbox: parent.sandbox,
        },
      );
    },
    dispose: async () => {
      await harness.dispose();
    },
  };
};

void test('the runtime providers answer the stage-1 adapter transcript', {
  timeout: 20_000,
}, async () => {
  const driver = runtimeDriver();
  try {
    const replayed = transcriptOf(await runScenario(driver));
    const golden = await readTranscript();
    for (const [index, step] of golden.steps.entries())
      assert.deepEqual(replayed.steps[index], step, step.label);
    assert.deepEqual(replayed, golden);
  } finally {
    await driver.dispose();
  }
});
