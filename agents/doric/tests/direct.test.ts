import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { AgentErrorObject } from 'agent';
import type { ProviderMessage, ProviderRequest } from 'llms';

import { defaultConfig } from '../src/lib/config.js';
import { directSystemPrompt, runDirectPrompt } from '../src/lib/direct.js';

test('includes the Direct instruction and every skill body once in bundle order', () => {
  const system = directSystemPrompt([
    skill('first', 'First body.'),
    skill('second', 'Second body.'),
  ]);
  const first = system.indexOf('First body.');
  const second = system.indexOf('Second body.');

  assert.match(system, /Complete the user's request in the sandbox/u);

  assert.ok(first >= 0 && first < second);

  assert.equal(system.lastIndexOf('First body.'), first);

  assert.equal(system.lastIndexOf('Second body.'), second);
});

test('feeds complete persisted history into each fresh Direct agent', async () => {
  const harness = directHarness();

  await harness.run('prompt-1');

  await harness.run('prompt-2');

  assert.deepEqual(harness.requests[1]?.messages.slice(1), [
    { role: 'user', content: 'prompt-1' },
    { role: 'assistant', content: 'answer-prompt-1' },
    { role: 'user', content: 'prompt-2' },
  ]);
});

test('binds every fresh Direct agent to the session sandbox', async () => {
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
    { role: 'user', content: 'fail' },
    { role: 'user', content: 'after-failure' },
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

const directHarness = (configuration = structuredClone(defaultConfig)) => {
  let messages: readonly ProviderMessage[] = [];
  const requests: ProviderRequest[] = [];
  const events: Array<{ event: unknown }> = [];
  const boundSandboxes: string[] = [];

  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);

      const input = request.messages.at(-1)?.content;

      yield {
        type: 'response.started' as const,
        provider: { id: 'provider', name: 'provider' },
        model: request.model,
      };

      yield { type: 'reasoning.delta' as const, delta: 'inspect' };

      if (input === 'fail') {
        throw new Error('provider failed');
      }

      if (input === 'use-tool') {
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'Inspecting.',
            finishReason: 'tool_calls' as const,
            toolCalls: [{ id: 'call-1', name: 'inspect', arguments: '{}' }],
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
            execute: async () => ({}),
          };
        },
      ],
    },
  };

  const store = {
    find: async () => ({
      session: { id: sessionId },
      snapshot: generation.snapshot,
      messages,
    }),
    finishPrompt: async (_id: string, value: readonly ProviderMessage[]) => {
      messages = value;
    },
    appendEvent: async (
      _sessionId: string,
      promptId: string,
      event: unknown,
    ) => {
      const stored = {
        sessionId,
        promptId,
        sequence: events.length + 1,
        type: (event as { type: string }).type,
        event,
        createdAt: new Date(0).toISOString(),
      };

      events.push(stored);

      return stored;
    },
  };

  return {
    requests,
    events,
    boundSandboxes,
    run: (prompt: string) =>
      runDirectPrompt({
        sessionId,
        promptId,
        prompt,
        generation: generation as never,
        sandbox: { id: 'vm-1' } as never,
        signal: new AbortController().signal,
        store: store as never,
        event: () => undefined,
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
const sessionId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
