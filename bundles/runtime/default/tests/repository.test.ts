import assert from 'node:assert/strict';
import test from 'node:test';

import { HooksV1 } from 'bundle/contracts';
import type { ProviderMessage, ProviderRequest } from 'llms';
import {
  type CwdChanged,
  type CwdRepo,
  type ExecutorThread,
  type InputSource,
  RuntimeHooksV1,
} from 'runtime/contracts';

import { DefaultHooksV1 } from '../src/contracts/index.js';
import { systemPromptWith } from '../src/host/executor.js';
import {
  bundleServices,
  fakeThreadState,
  harnessVariables,
  projectId,
  promptId,
  runPrompt,
  sandboxSection,
  skill,
  threadId,
} from './support/harness.js';
import { repositoryPrompt } from './support/prompts.js';

/*
 * The coding workflow is a standing instruction: the default bundle gives it
 * once per Thread — when a task starts at a repository root or a running
 * prompt moves into one, while the history the model reads does not hold it —
 * and the run records it as retained, so compaction keeps it.
 */

const skills = [skill('sandbox', 'Inspect before reporting.')];
const key = 'default:coding-workflow';
const envelope =
  '<bundle-instruction bundle="default" reason="coding-workflow">';

/** The default bundle over a Thread whose runtime queues every instruction. */
const activated = async (
  options: {
    /** Runs while the model answers its first request, as a tool would. */
    readonly onFirstRequest?: () => Promise<void>;
  } = {},
) => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  const services = bundleServices({
    skills,
    onInstruct: ({ prompt, reason, retain }) =>
      state.steer(prompt, {
        kind: 'bundle',
        bundleId: 'default',
        reason,
        ...(retain === true ? { retain: true as const } : {}),
      }),
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      stream: async function* (request: ProviderRequest) {
        requests.push(request);
        if (requests.length === 1) await options.onFirstRequest?.();
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'done',
            finishReason: 'stop' as const,
            toolCalls: [],
          },
        };
      },
    },
  });
  await services.activate();
  const hooks = services.harness.services.use(HooksV1);
  return { services, requests, state, hooks };
};

type Harness = Awaited<ReturnType<typeof activated>>;

const run = (
  { services, state }: Harness,
  prompt: string,
  options: {
    readonly id?: string;
    readonly source?: InputSource;
    readonly cwdRepo?: CwdRepo;
    readonly thread?: Partial<ExecutorThread>;
  } = {},
) => runPrompt(services, state, prompt, options);

const stored = ({ state }: Harness) =>
  (state.parts().messages ?? []) as readonly ProviderMessage[];

const retained = ({ state }: Harness) =>
  (state.parts().meta as { retained?: Record<string, number> } | undefined)
    ?.retained;

const instructionsIn = (messages: readonly ProviderMessage[]) =>
  messages.filter(({ content }) => String(content).startsWith(envelope));

void test('gives a task the reader starts at a repository root the workflow before its first model request', async () => {
  const harness = await activated();

  await run(harness, 'fix the bug', { cwdRepo: 'github' });

  assert.deepEqual(harness.services.instructions, [
    {
      id: threadId,
      promptId,
      prompt: repositoryPrompt,
      reason: 'coding-workflow',
      retain: true,
    },
  ]);
  assert.equal(instructionsIn(harness.requests[0]?.messages ?? []).length, 1);
});

void test('records the workflow it stored as retained, at the index it sits', async () => {
  const harness = await activated();

  await run(harness, 'fix the bug', { cwdRepo: 'git' });

  const at = retained(harness)?.[key];
  assert.ok(at !== undefined);
  assert.ok(String(stored(harness)[at]?.content).startsWith(envelope));
});

void test('gives a later task in the same Thread nothing again', async () => {
  const harness = await activated();

  await run(harness, 'fix the bug', { cwdRepo: 'git', id: 'first' });
  await run(harness, 'and the next one', { cwdRepo: 'git', id: 'second' });

  assert.equal(harness.services.instructions.length, 1);
  assert.equal(instructionsIn(stored(harness)).length, 1);
});

void test('gives a delegated step at a repository root the workflow', async () => {
  const harness = await activated();

  await run(harness, 'Type: Search', {
    cwdRepo: 'git',
    source: { kind: 'parent', threadId: 'parent', promptId: 'p' },
  });

  assert.equal(harness.services.instructions.length, 1);
});

void test('gives nothing outside a repository, nor to the results and outputs that continue running work', async () => {
  const harness = await activated();

  await run(harness, 'plan a trip', { id: 'outside' });
  for (const [index, source] of (
    [
      {
        kind: 'result',
        threadId: 'child',
        promptId: 'c',
        requestPromptId: promptId,
      },
      { kind: 'terminal', terminalId: 't', promptId: 'p' },
    ] as const
  ).entries())
    await run(harness, 'continue', {
      id: `continue-${index}`,
      cwdRepo: 'git',
      source,
    });

  assert.deepEqual(harness.services.instructions, []);
});

void test('gives a running prompt the workflow once when it moves into a repository root', async () => {
  const move = (cwd: string, cwdRepo: CwdRepo): CwdChanged => ({
    projectId,
    threadId,
    promptId,
    cwd,
    cwdRepo,
    previous: { cwd: '/workspace' },
  });
  let harness: Harness | undefined;
  harness = await activated({
    onFirstRequest: async () => {
      const runtime = harness?.hooks.define(RuntimeHooksV1);
      await runtime?.onThreadCwdChangedHook.execute(
        move('/workspace/a', 'git'),
      );
      await runtime?.onThreadCwdChangedHook.execute(
        move('/workspace/b', 'github'),
      );
    },
  });

  await run(harness, 'fix the bug');

  assert.equal(harness.services.instructions.length, 1);
  assert.equal(instructionsIn(stored(harness)).length, 1);
  assert.ok(retained(harness)?.[key] !== undefined);
});

void test('frames a bundle instruction in a bundle-instruction envelope naming the bundle and reason', async () => {
  const harness = await activated();

  await run(harness, 'Follow the workflow.', {
    source: { kind: 'bundle', bundleId: 'default', reason: 'coding-workflow' },
  });

  assert.equal(
    harness.requests[0]?.messages.at(-1)?.content,
    `${envelope}\nFollow the workflow.\n</bundle-instruction>`,
  );
});

void test('sends the system prompt an onBeforeModelRequestHook handler returns', async () => {
  const harness = await activated();
  harness.hooks.use(DefaultHooksV1).onBeforeModelRequestHook(({ system }) => ({
    system: `${system}\n\n# Project rules\n\nUse tabs.`,
  }));

  await run(harness, 'fix the bug');

  assert.deepEqual(
    harness.requests.map((request) => request.messages[0]?.content),
    [
      `${systemPromptWith(harnessVariables, sandboxSection)}\n\n# Project rules\n\nUse tabs.`,
    ],
  );
});

/** An agent a Thread runs as: its own instructions replace the workflow. */
const reviewer = {
  name: 'reviewer',
  source: 'workspace' as const,
  instructions: 'Review the diff.',
};

void test('EX4a gives an agent Thread that starts at a repository root no workflow', async () => {
  const harness = await activated();

  await run(harness, 'fix the bug', {
    cwdRepo: 'github',
    thread: { agent: reviewer },
  });

  assert.deepEqual(harness.services.instructions, []);
  assert.equal(instructionsIn(harness.requests[0]?.messages ?? []).length, 0);
});

void test('EX4b gives an agent Thread no workflow when its running prompt moves into a repository root', async () => {
  const move = (cwd: string, cwdRepo: CwdRepo): CwdChanged => ({
    projectId,
    threadId,
    promptId,
    cwd,
    cwdRepo,
    previous: { cwd: '/workspace' },
  });
  let harness: Harness | undefined;
  harness = await activated({
    onFirstRequest: async () => {
      const runtime = harness?.hooks.define(RuntimeHooksV1);
      await runtime?.onThreadCwdChangedHook.execute(
        move('/workspace/a', 'git'),
      );
      await runtime?.onThreadCwdChangedHook.execute(
        move('/workspace/b', 'github'),
      );
    },
  });

  await run(harness, 'fix the bug', { thread: { agent: reviewer } });

  assert.deepEqual(harness.services.instructions, []);
  assert.equal(instructionsIn(stored(harness)).length, 0);
  assert.equal(retained(harness)?.[key], undefined);
});

void test('EX5 gives a delegated step with its own model and effort but no agent the workflow', async () => {
  const harness = await activated();

  await run(harness, 'Type: Search', {
    cwdRepo: 'git',
    source: { kind: 'parent', threadId: 'parent', promptId: 'p' },
    thread: { model: 'm', effort: 'low' },
  });

  assert.equal(harness.services.instructions.length, 1);
});
