import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentErrorObject } from 'agent';
import { type CallScope, HooksV1 } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ProviderMessage, ProviderRequest } from 'llms';
import type { CwdRepo, ExecutorThread, InputSource } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { DefaultHooksV1 } from '../src/contracts/index.js';
import { systemPromptWith } from '../src/host/executor.js';
import {
  bundleServices,
  fakeThreadState,
  harnessVariables,
  PersistenceFailure,
  projectId,
  promptId,
  runPrompt,
  sandboxSection,
  seedHistory,
  skill,
  testConfiguration,
  threadId,
} from './support/harness.js';
import { builtInSkillsPrompt } from './support/prompts.js';

// Ported from agents/doric/tests/direct.test.ts: the same scenarios, run
// through executor/v1 with the runtime's prompt session faked.

const callId = 'call-1';

const harnessOf = (
  configuration = testConfiguration(),
  onEvent: (value: unknown) => void = () => undefined,
  tools?: (inspect: unknown) => readonly unknown[],
) => {
  let executions = 0;
  const requests: ProviderRequest[] = [];
  const toolScopes: (CallScope | undefined)[] = [];
  const state = fakeThreadState();
  state.onEvent(onEvent);
  /** What the Thread held when the provider was asked for each turn. */
  const calls: {
    readonly persisted: unknown;
    readonly executions: number;
  }[] = [];
  const owner = createTestServices({ bundle: { id: 'tools-owner' } });
  // A tool the bundles registered: bound to its bundle's services, it runs
  // under the prompt's call. It declares no settings.
  const inspect = inspectTool(() => executions++, toolScopes).bind(
    owner.services,
  );
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      calls.push({ persisted: state.parts().messages, executions });
      const content = request.messages.at(-1)?.content;
      assert.equal(typeof content, 'string');
      const input = (content as string)
        .replace(/^<user-request>\n/, '')
        .replace(/\n<\/user-request>$/, '');
      yield {
        type: 'response.started' as const,
        provider: { id: 'provider', name: 'provider' },
        model: request.model,
      };
      yield { type: 'reasoning.delta' as const, delta: 'inspect' };
      if (input === 'fail') throw new Error('provider failed');
      if (input === 'use-tool') {
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'Inspecting.',
            finishReason: 'tool_calls' as const,
            toolCalls: [{ id: callId, name: 'inspect', arguments: '{}' }],
          },
        };
        return;
      }
      yield {
        type: 'response.finished' as const,
        finish: {
          text: `answer-${String(input)}`,
          finishReason: 'stop' as const,
          toolCalls: [],
        },
      };
    },
  };
  const services = bundleServices({
    configuration,
    provider,
    tools: (tools?.(inspect) ?? [inspect]).map((tool) => ({
      bundleId: 'tools-owner',
      alwaysAvailable: false,
      tool: tool as never,
    })),
    skills: [skill('sandbox', 'Inspect before reporting.')],
  });
  let activated: Promise<void> | undefined;

  return {
    state,
    requests,
    calls,
    toolScopes,
    services,
    executions: () => executions,
    events: () =>
      state.events.map(({ event }) => (event as { type: string }).type),
    run: async (prompt: string, signal?: AbortSignal) => {
      activated ??= Promise.resolve(services.activate());
      await activated;
      return runPrompt(
        services,
        state,
        prompt,
        signal === undefined ? {} : { signal },
      );
    },
  };
};

const inspectTool = (executed: () => void, scopes: (CallScope | undefined)[]) =>
  defineTool({
    name: 'inspect',
    description: 'Inspect state.',
    input: z.object({}),
    output: z.object({}),
    execute: async (_payload, call) => {
      executed();
      scopes.push(call.scope);
      return {};
    },
  });

void test('retains a completed tool result and its event when a full disk rejects persistence until recovery', async () => {
  const harness = harnessOf();
  let full = false;
  harness.state.failWhen((entry) => {
    if (
      (entry.event as { type?: string } | undefined)?.type === 'tool.finished'
    )
      full = true;
    return full;
  });
  let failure: PersistenceFailure | undefined;
  await assert.rejects(harness.run('use-tool'), (error: unknown) => {
    if (!(error instanceof PersistenceFailure)) return false;
    failure = error;
    return true;
  });
  assert.equal(harness.executions(), 1);
  assert.ok(failure?.retry);
  full = false;
  harness.state.failWhen(undefined);
  await failure.retry();
  assert.equal(
    harness.events().filter((type) => type === 'tool.finished').length,
    1,
  );
  await harness.run('after');
  assert.ok(
    harness.requests
      .at(-1)
      ?.messages.some((message) => message.role === 'tool'),
  );
  assert.equal(harness.executions(), 1);
});

void test('starts the system prompt with the default instruction and keeps an empty skill section out of it', () => {
  const system = systemPromptWith(harnessVariables, '');

  assert.match(system, /Complete the user's request in the project sandbox/u);
  assert.ok(!system.includes('# Skills'));
});

void test('separates the skill section from the default instruction by a blank line, verbatim', () => {
  const section = '# Skills\n\n### Skill: first\n\n\nFirst body.\n';

  assert.equal(
    systemPromptWith(harnessVariables, section),
    `${systemPromptWith(harnessVariables, '')}\n\n${section}`,
  );
});

void test('sends the default instruction with the always-available skill bodies and the tools tools/v1 lists', async () => {
  const harness = harnessOf();
  await harness.run('prompt-1');

  assert.deepEqual(harness.requests[0]?.messages[0], {
    role: 'system',
    content: systemPromptWith(harnessVariables, sandboxSection),
  });
  assert.deepEqual(
    harness.requests[0]?.tools?.map(({ name }) => name),
    ['inspect'],
  );
});

void test('feeds complete persisted history into each fresh default agent', async () => {
  const harness = harnessOf();
  await harness.run('prompt-1');
  await harness.run('prompt-2');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '<user-request>\nprompt-1\n</user-request>' },
    { role: 'assistant', content: 'answer-prompt-1' },
    { role: 'user', content: '<user-request>\nprompt-2\n</user-request>' },
  ]);
});

void test('writes the history in the default.history/v1 format with its message count', async () => {
  const harness = harnessOf();
  seedHistory(harness.state, { checkpoints: { [promptId]: 0 } });
  await harness.run('prompt-1');

  assert.equal(harness.state.format(), 'default.history/v1');
  assert.deepEqual(harness.state.parts().meta, {
    checkpoints: { [promptId]: 0 },
    messageCount: 2,
    retained: {},
  });
  assert.equal((harness.state.parts().messages as unknown[]).length, 2);
});

void test('binds every tool to a call scoped to the running prompt', async () => {
  const harness = harnessOf();
  await harness.run('use-tool').catch(() => undefined);

  assert.deepEqual(harness.toolScopes, [{ projectId, threadId, promptId }]);
});

void test('refuses a tool that defineTool did not bind before asking the model', async () => {
  const harness = harnessOf(undefined, undefined, () => [
    {
      name: 'loose',
      definition: { name: 'loose' },
      settings: [],
      execute: () => Promise.resolve({}),
    },
  ]);

  await assert.rejects(harness.run('prompt'), {
    name: 'TypeError',
    message: 'Tool "loose" was not defined with defineTool.',
  });
  assert.equal(harness.requests.length, 0);
});

void test('refuses a prompt whose tool settings are unmet before asking the model', async () => {
  const owner = createTestServices({ bundle: { id: 'tools-owner' } });
  const configured = defineTool({
    name: 'configured',
    description: 'Needs a key.',
    input: z.object({}),
    output: z.object({}),
    settings: [
      { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    ],
    execute: () => Promise.resolve({}),
  }).bind(owner.services);
  const harness = harnessOf(undefined, undefined, () => [configured]);

  await assert.rejects(harness.run('prompt'), {
    message: 'Tool configured requires a apiKey value.',
  });
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.events(), []);
});

void test('fails with the models/v1 refusal when the configured provider is unavailable', async () => {
  const configuration = testConfiguration();
  const harness = harnessOf({
    ...configuration,
    models: {
      execution: { ...configuration.models.execution, providerId: 'gone' },
    },
  });

  await assert.rejects(harness.run('prompt'), {
    message: 'Configured provider is unavailable.',
  });
  assert.deepEqual(harness.services.resolved, [
    {
      providerId: 'gone',
      model: configuration.models.execution.model,
      effort: 'low',
    },
  ]);
});

void test('persists streamed default-agent events with the configured provider id on response.started', async () => {
  const harness = harnessOf();
  await harness.run('prompt');

  assert.ok(harness.events().includes('reasoning.delta'));
  const started = harness.state.events.find(
    ({ event }) => (event as { type: string }).type === 'response.started',
  );
  assert.equal(
    (started?.event as { providerId?: string } | undefined)?.providerId,
    'openrouter',
  );
  assert.deepEqual(
    harness.events().filter((type) => type.startsWith('agent.')),
    ['agent.started', 'agent.finished'],
  );
});

void test('answers the final text of the run', async () => {
  const harness = harnessOf();

  assert.equal(await harness.run('prompt'), 'answer-prompt');
});

void test('persists partial history after failure for the next prompt', async () => {
  const harness = harnessOf();
  await assert.rejects(harness.run('fail'));
  await harness.run('after-failure');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '<user-request>\nfail\n</user-request>' },
    { role: 'user', content: '<user-request>\nafter-failure\n</user-request>' },
  ]);
});

void test('uses the configured execution model and effort', async () => {
  const configuration = testConfiguration();
  const harness = harnessOf({
    ...configuration,
    models: {
      execution: {
        providerId: 'openrouter',
        model: 'configured-model',
        effort: 'high',
      },
    },
  });

  await harness.run('prompt');

  assert.equal(harness.requests[0]?.model, 'configured-model');
  assert.equal(harness.requests[0]?.effort, 'high');
});

void test('enforces the configured default-agent turn limit', async () => {
  const harness = harnessOf({
    ...testConfiguration(),
    execution: { maxTurns: 1 },
  });

  await assert.rejects(harness.run('use-tool'), (error: unknown) => {
    assert.ok(error instanceof AgentErrorObject);
    assert.equal(error.data.code, 'turn_limit_exceeded');
    return true;
  });
  assert.equal(harness.requests.length, 1);
});

void test('does not start a sandbox tool after interruption and retains resumable tool history', async () => {
  const controller = new AbortController();
  const harness = harnessOf(testConfiguration(), (value) => {
    if ((value as { type: string }).type === 'tool.started') controller.abort();
  });
  await assert.rejects(harness.run('use-tool', controller.signal), {
    name: 'AbortError',
  });
  assert.equal(harness.executions(), 0);
  await harness.run('continue');
  const replay = harness.requests.at(-1)?.messages;
  assert.ok(
    replay?.some(
      (message) =>
        message.role === 'tool' && message.toolResultStatus === 'incomplete',
    ),
  );
});

void test('resumes an interrupted run from the history it had already written', async () => {
  const controller = new AbortController();
  const harness = harnessOf(testConfiguration(), (value) => {
    if ((value as { type: string }).type === 'tool.finished')
      controller.abort();
  });
  // The turn began at an empty history, which is what the runtime records for it.
  seedHistory(harness.state, { checkpoints: { [promptId]: 0 } });
  await assert.rejects(harness.run('use-tool', controller.signal), {
    name: 'AbortError',
  });
  // The interrupted run keeps its prompt unfinished, so the runtime runs it
  // again: the tool result it already had is still there, and its own input is
  // not repeated to say the same thing twice.
  await harness.run('use-tool');
  const sent = harness.requests.at(-1)?.messages ?? [];
  assert.ok(
    sent.some(
      (message) => message.role === 'tool' && message.toolCallId === callId,
    ),
  );
  assert.equal(
    sent.filter(({ role }) => role === 'user').length,
    1,
    'the input is carried once, before the work the interrupted run had done',
  );
  assert.equal(sent[1]?.role, 'user');
});

void test('answers a resumed history that ends in a tool call with no result', async () => {
  const harness = harnessOf();
  // A host stop in the middle of a tool leaves a history no provider accepts: an
  // assistant call the run never answered.
  seedHistory(harness.state, {
    messages: [
      { role: 'user', content: '<user-request>\nuse-tool\n</user-request>' },
      {
        role: 'assistant',
        content: 'Inspecting.',
        toolCalls: [{ id: callId, name: 'inspect', arguments: '{}' }],
      },
    ],
    checkpoints: { [promptId]: 0 },
  });

  await harness.run('use-tool');

  const sent = harness.requests[0]?.messages.slice(1) ?? [];
  // The interrupted call is answered before the run asks for anything, so every
  // call the history holds has a result of its own.
  assert.equal(sent[2]?.role, 'tool');
  assert.equal(sent[2]?.toolCallId, callId);
  assert.equal(sent[2]?.toolResultStatus, 'incomplete');
  assert.ok((sent[2]?.content?.length ?? 0) > 0);
  // Answering it is not the same as running it: a tool that already acted cannot
  // act twice, so the interrupted call is answered before the provider is asked
  // for the next turn.
  assert.equal(harness.calls[0]?.executions, 0);
  assert.deepEqual(
    sent.filter(({ role }) => role === 'user').map(({ content }) => content),
    ['<user-request>\nuse-tool\n</user-request>'],
  );
});

void test('keeps the original input and every assistant turn across successive resumptions', async () => {
  const controller = new AbortController();
  const harness = harnessOf(undefined, (event) => {
    if ((event as { type: string }).type === 'response.finished')
      controller.abort();
  });
  // A run stopped after a tool batch: its next turn is still owed.
  const history: readonly ProviderMessage[] = [
    { role: 'user', content: '<user-request>\ncontinue\n</user-request>' },
    {
      role: 'assistant',
      content: 'Work before the first restart.',
      toolCalls: [{ id: 'first', name: 'inspect', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'first', content: 'continue' },
  ];
  seedHistory(harness.state, {
    messages: history,
    checkpoints: { [promptId]: 0 },
  });
  // The first resumption answers, and is stopped right after its answer.
  await assert.rejects(harness.run('continue', controller.signal), {
    name: 'AbortError',
  });
  const sent = harness.requests.at(-1)?.messages.slice(1) ?? [];
  assert.deepEqual(sent, history);

  // The second finds the answer already stored and asks the model nothing:
  // sending it again would end the request on an assistant turn.
  assert.equal(await harness.run('continue'), 'answer-continue');
  assert.equal(harness.requests.length, 1);
  const stored = harness.state.parts().messages as ProviderMessage[];
  assert.deepEqual(stored.slice(0, history.length), history);
  assert.equal(stored.filter(({ role }) => role === 'user').length, 1);
  assert.equal(stored.filter(({ role }) => role === 'assistant').length, 2);
  assert.equal(stored.at(-1)?.content, 'answer-continue');
});

void test('repairs only unanswered calls after a partially completed tool batch', async () => {
  const harness = harnessOf();
  const history: readonly ProviderMessage[] = [
    { role: 'user', content: '<user-request>\ncontinue\n</user-request>' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'done', name: 'inspect', arguments: '{}' },
        { id: 'interrupted', name: 'inspect', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'done', content: 'saved result' },
  ];
  seedHistory(harness.state, {
    messages: history,
    checkpoints: { [promptId]: 0 },
  });
  await harness.run('continue');
  const sent = harness.requests[0]?.messages.slice(1) ?? [];
  assert.deepEqual(sent.slice(0, history.length), history);
  assert.equal(sent.length, history.length + 1);
  assert.equal(sent.at(-1)?.toolCallId, 'interrupted');
  assert.equal(sent.at(-1)?.toolResultStatus, 'incomplete');
  assert.equal(harness.executions(), 0);
});

void test('saves the history on response.finished and tool.finished and once more when the run ends', async () => {
  const harness = harnessOf();
  await harness.run('use-tool').catch(() => undefined);

  const saves = harness.state.writes.map(({ history, event }) =>
    history === undefined
      ? `event:${(event as { type: string }).type}`
      : event === undefined
        ? 'history'
        : `history+event:${(event as { type: string }).type}`,
  );
  assert.ok(saves.includes('history+event:response.finished'));
  assert.ok(saves.includes('history+event:tool.finished'));
  assert.equal(saves.at(-1), 'history');
  assert.ok(
    saves
      .filter((entry) => entry.startsWith('history+'))
      .every(
        (entry) =>
          entry.endsWith('response.finished') ||
          entry.endsWith('tool.finished'),
      ),
  );
});

void test('takes the reader steering in after a tool and saves it before announcing it', async () => {
  const harness = harnessOf();
  harness.state.onEvent((value) => {
    if ((value as { type: string }).type === 'tool.started')
      harness.state.steer('summarize');
  });

  const text = await harness.run('use-tool');

  assert.equal(text, 'answer-summarize');
  const steered = harness.state.writes.find(
    ({ event }) =>
      (event as { type?: string } | undefined)?.type === 'agent.steered',
  );
  const saved = steered?.history?.parts.messages as
    | readonly ProviderMessage[]
    | undefined;
  assert.deepEqual(saved?.at(-1), {
    role: 'user',
    content: '<user-request>\nsummarize\n</user-request>',
  });
  assert.deepEqual(harness.state.steering, []);
});

void test('leaves steering untaken when the run answers without a further turn', async () => {
  const harness = harnessOf({
    ...testConfiguration(),
    execution: { maxTurns: 1 },
  });
  harness.state.onEvent((value) => {
    if ((value as { type: string }).type === 'response.started')
      harness.state.steer('too late');
  });

  assert.equal(await harness.run('plain'), 'answer-plain');
  assert.deepEqual(
    harness.state.steering.map((steer) => steer.prompt),
    ['too late'],
  );
});

void test('takes a background terminal result in within its own envelope', async () => {
  const harness = harnessOf();
  harness.state.onEvent((value) => {
    if ((value as { type: string }).type === 'tool.started')
      harness.state.steer('Command: npm test\nExit: 0', {
        kind: 'terminal',
        terminalId: 'term-1',
        promptId,
      });
  });

  await harness.run('use-tool');

  const steered = harness.state.writes.find(
    ({ event }) =>
      (event as { type?: string } | undefined)?.type === 'agent.steered',
  );
  const saved = steered?.history?.parts.messages as
    | readonly ProviderMessage[]
    | undefined;
  assert.deepEqual(saved?.at(-1), {
    role: 'user',
    content: `<terminal-output terminal="term-1" prompt="${promptId}">\nCommand: npm test\nExit: 0\n</terminal-output>`,
  });
});

void test('pauses without recording the failure when the generation running a tool is lost', async () => {
  const controller = new AbortController();
  const owner = createTestServices({ bundle: { id: 'tools-owner' } });
  const crashing = defineTool({
    name: 'inspect',
    description: 'Inspect state.',
    input: z.object({}),
    output: z.object({}),
    execute: () => {
      // The host aborts every prompt pinned to the lost generation before the
      // call rejects.
      controller.abort(new Error('generation lost'));
      return Promise.reject(
        Object.assign(new Error('The generation exited.'), {
          code: 'generation_lost',
        }),
      );
    },
  }).bind(owner.services);
  const harness = harnessOf(undefined, undefined, () => [crashing]);

  await assert.rejects(harness.run('use-tool', controller.signal), {
    message: 'generation lost',
  });
  assert.ok(!harness.events().includes('tool.failed'));
  const last = harness.state.writes.at(-1);
  assert.equal(last?.event, undefined);
  const saved = harness.state.parts().messages as ProviderMessage[];
  assert.equal(saved.at(-1)?.role, 'assistant');
  assert.equal(saved.at(-1)?.toolCalls?.[0]?.id, callId);
  assert.equal(
    harness.state.writes.filter(({ event }) => event === undefined).length,
    1,
    'the history is saved once, before the call is answered, and not again',
  );
});

/*
 * The bundle-instruction envelope and the onBeforeModelRequestHook, moved from
 * repository.test.ts with their helpers.
 */

const skills = [skill('sandbox', 'Inspect before reporting.')];
const envelope =
  '<bundle-instruction bundle="default" reason="coding-workflow">';

/** The default bundle over a fake Thread, its model answering every request. */
const activated = async (
  options: {
    /**
     * Steers an instruction the bundle gives into the run, as the runtime did
     * while the bundle gave one: a run then shows any instruction it gives.
     */
    readonly steer?: boolean;
  } = {},
) => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  // Spread, so the option reads as one the harness may no longer declare.
  const steering =
    options.steer === true
      ? {
          onInstruct: ({
            prompt,
            reason,
            retain,
          }: {
            readonly prompt: string;
            readonly reason: string;
            readonly retain?: boolean;
          }) =>
            state.steer(prompt, {
              kind: 'bundle',
              bundleId: 'default',
              reason,
              ...(retain === true ? { retain: true as const } : {}),
            }),
        }
      : {};
  const services = bundleServices({
    skills,
    ...steering,
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      stream: async function* (request: ProviderRequest) {
        requests.push(request);
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

type Activated = Awaited<ReturnType<typeof activated>>;

const run = (
  { services, state }: Activated,
  prompt: string,
  options: {
    readonly id?: string;
    readonly source?: InputSource;
    readonly cwdRepo?: CwdRepo;
    readonly thread?: Partial<ExecutorThread>;
  } = {},
) => runPrompt(services, state, prompt, options);

const stored = ({ state }: Activated) =>
  (state.parts().messages ?? []) as readonly ProviderMessage[];

const retained = ({ state }: Activated) =>
  (state.parts().meta as { retained?: Record<string, number> } | undefined)
    ?.retained;

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

void test('B4 gives a task the reader starts at a repository root no coding-workflow instruction', async () => {
  const harness = await activated({ steer: true });

  await run(harness, 'fix the bug', { cwdRepo: 'github' });

  const instructed = (messages: readonly ProviderMessage[]) =>
    messages.filter(({ content }) =>
      String(content).includes('reason="coding-workflow"'),
    );
  assert.deepEqual(instructed(harness.requests[0]?.messages ?? []), []);
  assert.deepEqual(instructed(stored(harness)), []);
  assert.equal(retained(harness)?.['default:coding-workflow'], undefined);
});

/*
 * The coding workflow is a built-in skill to load, listed first by the registry,
 * and offered only to a Thread that runs as no agent.
 */

/** The built-in skills of the cases below, in the registry's order. */
const workflowSkills = [
  skill('coding-workflow', 'Workflow body.', { alwaysAvailable: false }),
  skill('git-commit', 'Commit body.', { alwaysAvailable: false }),
  skill('git-rebase', 'Rebase body.', { alwaysAvailable: false }),
];

/** An agent a Thread runs as. */
const reviewer = {
  name: 'reviewer',
  source: 'workspace' as const,
  instructions: 'Review the diff.',
};

/**
 * One run over `workflowSkills` whose model calls load_skill for each name in
 * turn, then answers.
 */
const loadingRun = async (
  names: readonly string[],
  thread: Partial<ExecutorThread> = {},
) => {
  const requests: ProviderRequest[] = [];
  const services = bundleServices({
    skills: workflowSkills,
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      stream: async function* (request: ProviderRequest) {
        requests.push(request);
        const name = names[requests.length - 1];
        yield {
          type: 'response.finished' as const,
          finish:
            name === undefined
              ? { text: 'done', finishReason: 'stop' as const, toolCalls: [] }
              : {
                  text: '',
                  finishReason: 'tool_calls' as const,
                  toolCalls: [
                    {
                      id: `load-${requests.length}`,
                      name: 'load_skill',
                      arguments: JSON.stringify({ name }),
                    },
                  ],
                },
        };
      },
    },
  });
  await services.activate();
  await runPrompt(services, fakeThreadState(), 'do the task', { thread });
  const system = String(requests[0]?.messages[0]?.content);
  return {
    /** The rows of the built-in "Skills to load" table, in order. */
    rows: (system.split(`${builtInSkillsPrompt}\n\n`)[1] ?? '')
      .split('\n\n')[0]
      ?.split('\n')
      .slice(2),
    /** What each load_skill call answered, as the next request carries it. */
    answers: names.map((_, index) =>
      String(requests[index + 1]?.messages.at(-1)?.content),
    ),
  };
};

void test('B1 lists coding-workflow as the first built-in skill to load and loads its body', async () => {
  const { rows, answers } = await loadingRun(['coding-workflow']);

  assert.deepEqual(rows, [
    '| coding-workflow | coding-workflow description |',
    '| git-commit | git-commit description |',
    '| git-rebase | git-rebase description |',
  ]);
  assert.ok(
    answers[0]?.includes('# Skill: coding-workflow\n\nWorkflow body.'),
    answers[0],
  );
});

void test('B2 neither lists nor loads coding-workflow for a Thread that runs as an agent', async () => {
  const { rows, answers } = await loadingRun(['coding-workflow'], {
    agent: reviewer,
  });

  assert.ok(!rows?.some((row) => row.startsWith('| coding-workflow |')));
  assert.ok(
    answers[0]?.includes('Unknown skill id "coding-workflow".'),
    answers[0],
  );
  assert.ok(!answers[0]?.includes('Workflow body.'));
});

void test('B3 lists and loads the other built-in skills for an agent Thread, and all three for a plain one', async () => {
  const agent = await loadingRun(['git-commit', 'git-rebase'], {
    agent: reviewer,
  });

  assert.deepEqual(agent.rows, [
    '| git-commit | git-commit description |',
    '| git-rebase | git-rebase description |',
  ]);
  assert.ok(agent.answers[0]?.includes('# Skill: git-commit\n\nCommit body.'));
  assert.ok(agent.answers[1]?.includes('# Skill: git-rebase\n\nRebase body.'));

  const plain = await loadingRun([]);
  assert.deepEqual(plain.rows, [
    '| coding-workflow | coding-workflow description |',
    '| git-commit | git-commit description |',
    '| git-rebase | git-rebase description |',
  ]);
});
