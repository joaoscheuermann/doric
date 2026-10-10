import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentErrorObject } from 'agent';
import type { CallScope } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ProviderMessage, ProviderRequest } from 'llms';
import { defineTool } from 'tool';
import { z } from 'zod';

import { directSystemPrompt } from '../src/host/executor.js';
import {
  directServices,
  fakeThreadState,
  PersistenceFailure,
  projectId,
  promptId,
  runPrompt,
  seedHistory,
  skill,
  testConfiguration,
  threadId,
} from './support/harness.js';

// Ported from agents/doric/tests/direct.test.ts: the same scenarios, run
// through executor/v1 with the runtime's prompt session faked.

const callId = 'call-1';

const directHarness = (
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
      const input = (content as string).replace('# User request\n\n', '');
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
  const services = directServices({
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
  const harness = directHarness();
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

void test('includes the Direct instruction and every skill body once in bundle order', () => {
  const system = directSystemPrompt([
    skill('first', 'First body.'),
    skill('second', 'Second body.'),
  ]);
  const first = system.indexOf('First body.');
  const second = system.indexOf('Second body.');

  assert.match(system, /Complete the user's request in the project sandbox/u);
  assert.ok(first >= 0 && first < second);
  assert.equal(system.lastIndexOf('First body.'), first);
  assert.equal(system.lastIndexOf('Second body.'), second);
});

void test('preserves skill whitespace and separates each skill from the preceding prompt', () => {
  assert.equal(
    directSystemPrompt([
      skill('first', '\nFirst body.\n'),
      skill('second', 'Second body.'),
    ]),
    `${directSystemPrompt([])}\n\n## Skill: first\n\n\nFirst body.\n\n\n## Skill: second\n\nSecond body.`,
  );
});

void test('sends the Direct instruction with the skills tools/v1 and skills/v1 list', async () => {
  const harness = directHarness();
  await harness.run('prompt-1');

  assert.deepEqual(harness.requests[0]?.messages[0], {
    role: 'system',
    content: directSystemPrompt([
      skill('sandbox', 'Inspect before reporting.'),
    ]),
  });
  assert.deepEqual(
    harness.requests[0]?.tools?.map(({ name }) => name),
    ['inspect'],
  );
});

void test('feeds complete persisted history into each fresh Direct agent', async () => {
  const harness = directHarness();
  await harness.run('prompt-1');
  await harness.run('prompt-2');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '# User request\n\nprompt-1' },
    { role: 'assistant', content: 'answer-prompt-1' },
    { role: 'user', content: '# User request\n\nprompt-2' },
  ]);
});

void test('writes the history in the direct.history/v1 format with its message count', async () => {
  const harness = directHarness();
  seedHistory(harness.state, { checkpoints: { [promptId]: 0 } });
  await harness.run('prompt-1');

  assert.equal(harness.state.format(), 'direct.history/v1');
  assert.deepEqual(harness.state.parts().meta, {
    checkpoints: { [promptId]: 0 },
    messageCount: 2,
  });
  assert.equal((harness.state.parts().messages as unknown[]).length, 2);
});

void test('binds every tool to a call scoped to the running prompt', async () => {
  const harness = directHarness();
  await harness.run('use-tool').catch(() => undefined);

  assert.deepEqual(harness.toolScopes, [{ projectId, threadId, promptId }]);
});

void test('refuses a tool that defineTool did not bind before asking the model', async () => {
  const harness = directHarness(undefined, undefined, () => [
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
  const harness = directHarness(undefined, undefined, () => [configured]);

  await assert.rejects(harness.run('prompt'), {
    message: 'Tool configured requires a apiKey value.',
  });
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.events(), []);
});

void test('fails with the models/v1 refusal when the configured provider is unavailable', async () => {
  const configuration = testConfiguration();
  const harness = directHarness({
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

void test('persists streamed Direct events with the configured provider id on response.started', async () => {
  const harness = directHarness();
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
  const harness = directHarness();

  assert.equal(await harness.run('prompt'), 'answer-prompt');
});

void test('persists partial history after failure for the next prompt', async () => {
  const harness = directHarness();
  await assert.rejects(harness.run('fail'));
  await harness.run('after-failure');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '# User request\n\nfail' },
    { role: 'user', content: '# User request\n\nafter-failure' },
  ]);
});

void test('uses the configured execution model and effort', async () => {
  const configuration = testConfiguration();
  const harness = directHarness({
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

void test('enforces the configured Direct turn limit', async () => {
  const harness = directHarness({
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
  const harness = directHarness(testConfiguration(), (value) => {
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
  const harness = directHarness(testConfiguration(), (value) => {
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
  const harness = directHarness();
  // A host stop in the middle of a tool leaves a history no provider accepts: an
  // assistant call the run never answered.
  seedHistory(harness.state, {
    messages: [
      { role: 'user', content: '# User request\n\nuse-tool' },
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
    ['# User request\n\nuse-tool'],
  );
});

void test('keeps the original input and every assistant turn across successive resumptions', async () => {
  const controller = new AbortController();
  const harness = directHarness(undefined, (event) => {
    if ((event as { type: string }).type === 'response.finished')
      controller.abort();
  });
  const history: readonly ProviderMessage[] = [
    { role: 'user', content: '# User request\n\ncontinue' },
    { role: 'assistant', content: 'Work before the first restart.' },
  ];
  seedHistory(harness.state, {
    messages: history,
    checkpoints: { [promptId]: 0 },
  });
  await assert.rejects(harness.run('continue', controller.signal), {
    name: 'AbortError',
  });
  await harness.run('continue');
  const sent = harness.requests.at(-1)?.messages.slice(1) ?? [];
  assert.deepEqual(sent.slice(0, history.length), history);
  assert.equal(sent.filter(({ role }) => role === 'user').length, 1);
  assert.equal(sent.filter(({ role }) => role === 'assistant').length, 2);
});

void test('repairs only unanswered calls after a partially completed tool batch', async () => {
  const harness = directHarness();
  const history: readonly ProviderMessage[] = [
    { role: 'user', content: '# User request\n\ncontinue' },
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
  const harness = directHarness();
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
  const harness = directHarness(undefined, undefined, () => [crashing]);

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
