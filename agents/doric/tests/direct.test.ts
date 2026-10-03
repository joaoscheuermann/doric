import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { AgentErrorObject } from 'agent';
import type { ProviderMessage, ProviderRequest } from 'llms';

import {
  directSystemPrompt,
  runDirectPrompt,
} from '../src/lib/agents/direct/executor.js';
import { defaultConfig } from '../src/lib/config/schema.js';

test('includes the Direct instruction and every skill body once in bundle order', () => {
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

test('preserves skill whitespace and separates each skill from the preceding prompt', () => {
  assert.equal(
    directSystemPrompt([
      skill('first', '\nFirst body.\n'),
      skill('second', 'Second body.'),
    ]),
    `${directSystemPrompt([])}\n\n## Skill: first\n\n\nFirst body.\n\n\n## Skill: second\n\nSecond body.`,
  );
});

test('feeds complete persisted history into each fresh Direct agent', async () => {
  const harness = directHarness();
  await harness.run('prompt-1');
  await harness.run('prompt-2');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '# User request\n\nprompt-1' },
    { role: 'assistant', content: 'answer-prompt-1' },
    { role: 'user', content: '# User request\n\nprompt-2' },
  ]);
});

test('binds every fresh Direct agent to the project sandbox', async () => {
  const harness = directHarness();
  await harness.run('prompt-1');
  await harness.run('prompt-2');

  assert.equal(harness.boundSandboxes.length, 2);
  assert.deepEqual(harness.boundSandboxes, ['vm-1', 'vm-1']);
});

test('persists streamed Direct events', async () => {
  const harness = directHarness();
  await harness.run('prompt');

  assert.ok(
    harness.events.some(
      ({ event }) => (event as { type?: string }).type === 'reasoning.delta',
    ),
  );
});

test('persists partial history after failure for the next prompt', async () => {
  const harness = directHarness();
  await assert.rejects(harness.run('fail'));
  await harness.run('after-failure');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: '# User request\n\nfail' },
    { role: 'user', content: '# User request\n\nafter-failure' },
  ]);
});

test('uses the configured execution model and effort', async () => {
  const configuration = structuredClone(defaultConfig);
  configuration.models.execution.model = 'configured-model';
  configuration.models.execution.effort = 'high';
  const harness = directHarness(configuration);

  await harness.run('prompt');

  assert.equal(harness.requests[0]?.model, 'configured-model');
  assert.equal(harness.requests[0]?.effort, 'high');
});

test('enforces the configured Direct turn limit', async () => {
  const configuration = structuredClone(defaultConfig);
  configuration.execution.maxTurns = 1;
  const harness = directHarness(configuration);

  await assert.rejects(harness.run('use-tool'), (error: unknown) => {
    assert.ok(error instanceof AgentErrorObject);
    assert.equal(error.data.code, 'turn_limit_exceeded');
    return true;
  });
  assert.equal(harness.requests.length, 1);
});

test('does not start a sandbox tool after interruption and retains resumable tool history', async () => {
  const controller = new AbortController();
  const harness = directHarness(structuredClone(defaultConfig), (value) => {
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

test('resumes an interrupted run from the history it had already written', async () => {
  const controller = new AbortController();
  const harness = directHarness(structuredClone(defaultConfig), (value) => {
    if ((value as { type: string }).type === 'tool.finished')
      controller.abort();
  });
  // The turn began at an empty history, which is what the host records for it.
  harness.seed({ checkpoints: { [promptId]: 0 } });
  await assert.rejects(harness.run('use-tool', controller.signal), {
    name: 'AbortError',
  });
  // The interrupted run keeps its prompt unfinished, so the host runs it again:
  // the tool result it already had is still there, and its own input is not
  // repeated to say the same thing twice.
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

test('answers a resumed history that ends in a tool call with no result', async () => {
  const harness = directHarness();
  // A host stop in the middle of a tool leaves a history no provider accepts: an
  // assistant call the run never answered.
  harness.seed({
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
  harness.seed({ messages: history, checkpoints: { [promptId]: 0 } });
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
  harness.seed({ messages: history, checkpoints: { [promptId]: 0 } });
  await harness.run('continue');
  const sent = harness.requests[0]?.messages.slice(1) ?? [];
  assert.deepEqual(sent.slice(0, history.length), history);
  assert.equal(sent.length, history.length + 1);
  assert.equal(sent.at(-1)?.toolCallId, 'interrupted');
  assert.equal(sent.at(-1)?.toolResultStatus, 'incomplete');
  assert.equal(harness.executions(), 0);
});

const directHarness = (
  configuration = structuredClone(defaultConfig),
  onEvent: (value: unknown) => void = () => undefined,
) => {
  let messages: readonly ProviderMessage[] = [];
  let checkpoints: Readonly<Record<string, number>> = {};
  let executions = 0;
  const requests: ProviderRequest[] = [];
  const events: Array<{ event: unknown }> = [];
  const boundSandboxes: string[] = [];
  /** What the host held when it asked the provider for each turn. */
  const calls: {
    readonly persisted: readonly ProviderMessage[];
    readonly executions: number;
  }[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      calls.push({ persisted: messages, executions });
      const input = String(request.messages.at(-1)?.content).replace(
        '# User request\n\n',
        '',
      );
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
  const generation = {
    snapshot: {
      configuration,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    },
    providers: new Map([[configuration.models.execution.providerId, provider]]),
    redactions: () => [],
    catalog: {
      skills: [skill('sandbox', 'Inspect before reporting.')],
      tools: [
        // A tool factory binds to the sandbox at the moment a run is created, so
        // the run records which one it received. It declares no settings.
        Object.assign(
          (sandbox: { id: string }) => {
            boundSandboxes.push(sandbox.id);
            return {
              name: 'inspect',
              description: 'Inspect state.',
              input: z.object({}),
              output: z.object({}),
              definition: {
                name: 'inspect',
                inputSchema: { type: 'object', properties: {} },
                outputSchema: { type: 'object', properties: {} },
                strict: true,
              },
              execute: async () => {
                executions += 1;
                return {};
              },
            };
          },
          { settings: [] },
        ),
      ],
    },
  };
  const store = {
    find: async () => ({
      thread: { id: threadId, projectId },
      messages,
      checkpoints,
    }),
    saveMessages: async (_id: string, value: readonly ProviderMessage[]) => {
      messages = value;
    },
    appendEvent: async (
      _threadId: string,
      promptId: string,
      event: unknown,
    ) => {
      const stored = {
        projectId,
        threadId,
        promptId,
        sequence: events.length + 1,
        type: (event as { type: string }).type,
        event,
        createdAt: new Date(0).toISOString(),
      };
      events.push(stored);
      onEvent(event);
      return stored;
    },
  };
  return {
    requests,
    calls,
    events,
    boundSandboxes,
    executions: () => executions,
    /**
     * The durable state a Thread holds before a run, as the runner would have
     * left it: the history a previous run wrote, and the turn boundary the host
     * recorded for this prompt.
     */
    seed: (value: {
      readonly messages?: readonly ProviderMessage[];
      readonly checkpoints?: Readonly<Record<string, number>>;
    }) => {
      messages = value.messages ?? messages;
      checkpoints = value.checkpoints ?? checkpoints;
    },
    run: (prompt: string, signal = new AbortController().signal) =>
      runDirectPrompt({
        thread: { id: threadId, projectId } as never,
        job: { id: promptId, prompt, source: { kind: 'user' } },
        generation: generation as never,
        sandbox: { id: 'vm-1' } as never,
        signal,
        store: store as never,
        publisher: { event: () => undefined } as never,
        host: {
          threads: {},
          workspace: {
            cwd: () => '/workspace',
            setCwd: async () => ({ status: 'set', cwd: '/workspace' }),
          },
        } as never,
      }),
  };
};

const skill = (name: string, body: string) => ({
  name,
  description: `${name} description`,
  body,
  allowedTools: [],
  indexText: `${name} ${body}`,
});
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const callId = 'call-1';
