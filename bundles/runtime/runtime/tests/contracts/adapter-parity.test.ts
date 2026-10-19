import assert from 'node:assert/strict';
import test from 'node:test';

import type { CallScope } from 'bundle/contracts';

import { createHarness, deferred } from '../domain/support/harness.js';
import {
  type CaptureDriver,
  type Outcome,
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

/**
 * A Thread view is the record a Thread method answers with: it is the only
 * value in the transcript carrying the Thread's `lastSequence`. The runtime
 * records who opened a Thread in `origin`, and the golden — a recording of the
 * stage-1 adapter, which cannot be recorded again — predates the field. It is
 * dropped from both sides for the same reason the `terminal/v1` steps are:
 * what moved on is named here, and everything else still has to match byte for
 * byte.
 */
const withoutThreadOrigin = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutThreadOrigin);
  if (value === null || typeof value !== 'object') return value;
  const opens = 'lastSequence' in value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'origin' || !opens)
      .map(([key, entry]) => [key, withoutThreadOrigin(entry)]),
  );
};

/** The transcript as the comparison reads it: without what the golden predates. */
const comparable = <T extends { readonly steps: readonly unknown[] }>(
  transcript: T,
): T => ({
  ...transcript,
  steps: transcript.steps.map((step) => ({
    ...(step as object),
    outcome: withoutThreadOrigin((step as { outcome: Outcome }).outcome),
  })) as T['steps'],
});

void test('the runtime providers answer the stage-1 adapter transcript', {
  timeout: 20_000,
}, async () => {
  const driver = runtimeDriver();
  try {
    // terminal/v1 is the `terminal` bundle's since the stage-10 host switch,
    // not a runtime provider any more; its own tests own that parity.
    const runtimeSteps = <T extends { readonly steps: readonly unknown[] }>(
      transcript: T,
    ): T => ({
      ...transcript,
      steps: transcript.steps.filter(
        (step) => (step as { contract?: string }).contract !== 'terminal/v1',
      ),
    });
    const replayed = comparable(
      runtimeSteps(transcriptOf(await runScenario(driver))),
    );
    const golden = comparable(runtimeSteps(await readTranscript()));
    for (const [index, step] of golden.steps.entries())
      assert.deepEqual(
        replayed.steps[index],
        step,
        (step as { label: string }).label,
      );
    assert.deepEqual(replayed, golden);
  } finally {
    await driver.dispose();
  }
});
