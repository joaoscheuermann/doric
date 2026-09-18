import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import type { ProviderStreamEvent } from 'llms';
import { createMessageStorage, type MessageStorage } from 'messages';
import { createToolStorage, defineTool, ToolErrorObject } from 'tool';

import {
  type Agent,
  AgentErrorObject,
  type AgentRunOptions,
} from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';

const invoke = (
  agent: Agent,
  mode: Mode,
  options: AgentRunOptions = {},
): Promise<unknown> =>
  mode === 'complete'
    ? agent.complete('Run tools.', options)
    : collect(agent.stream('Run tools.', options));

const assertIncomplete = (messages: MessageStorage, callId: string): void => {
  const result = messages
    .list()
    .find(
      (message) => message.role === 'tool' && message.toolCallId === callId,
    );

  assert.ok(result);

  assert.equal(result.toolResultStatus, 'incomplete');
};

test('structured stream suppresses every provider event from a rejected executable batch', async () => {
  const marker = 'rejected-private-event';
  let executions = 0;

  const tools = createToolStorage(
    ['first', 'second'].map((name) =>
      defineTool({
        name,
        input: z.object({ value: z.string() }),
        output: z.string(),
        execute: (_sandbox, { value }) => {
          executions += 1;

          return value;
        },
      })(undefined as never),
    ),
  );

  const rejected = completeFinish(marker, [
    call('first', { value: 'valid' }, 'call-first'),
    call('second', { value: 42 }, 'call-second'),
  ]);

  const provider = createProvider({
    stream: (request, index) => {
      if (index > 0) {
        const terminal = request.tools?.at(-1)?.name ?? 'missing-terminal';

        return streamEvents(
          completeFinish('', [call(terminal, { answer: 'done' })]),
        );
      }

      return (async function* (): AsyncIterable<ProviderStreamEvent<unknown>> {
        yield {
          type: 'response.started',
          provider: 'fake',
          model: marker,
        };

        yield { type: 'text.delta', delta: marker };

        yield { type: 'reasoning.delta', delta: marker };

        yield {
          type: 'usage',
          usage: { inputTokens: 999_999, totalTokens: 999_999 },
        };

        yield { type: 'response.finished', finish: rejected };
      })();
    },
  });
  const repairs: number[] = [];

  const agent = createAgent({
    provider: provider.provider,
    tools,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  const events = await collect(
    agent.stream('Return evidence.', {
      schema: z.object({ answer: z.string() }),
      onToolCallRepair: ({ attempt }) => {
        repairs.push(attempt);
      },
    }),
  );

  assert.equal(executions, 0);

  assert.deepEqual(repairs, [1]);

  assert.doesNotMatch(JSON.stringify(events), new RegExp(marker, 'u'));

  assert.equal(
    events.some(
      (event) => event.type === 'usage' && event.usage.totalTokens === 999_999,
    ),
    false,
  );

  assert.equal(
    events.filter((event) => event.type === 'response.finished').length,
    1,
  );
});

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} stores an incomplete result for a final rejected terminal call`, async () => {
    const callId = `terminal-${mode}`;

    const provider = createProvider({
      complete: (request) =>
        completeFinish('', [
          call(
            request.tools?.at(-1)?.name ?? 'missing-terminal',
            {
              answer: 42,
            },
            callId,
          ),
        ]),
      stream: (request) =>
        streamEvents(
          completeFinish('', [
            call(
              request.tools?.at(-1)?.name ?? 'missing-terminal',
              {
                answer: 42,
              },
              callId,
            ),
          ]),
        ),
    });
    const messages = createMessageStorage();

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages,
      system: '',
      model: 'fake-model',
    });

    await assert.rejects(
      invoke(agent, mode, {
        schema: z.object({ answer: z.string() }),
        maxToolCallRepairs: 0,
      }),
      (error: unknown) =>
        error instanceof AgentErrorObject &&
        error.data.code === 'invalid_structured_output',
    );

    assertIncomplete(messages, callId);
  });

  test(`${mode} stores an incomplete result for a final rejected executable call`, async () => {
    const callId = `executable-${mode}`;
    let executions = 0;

    const tools = createToolStorage([
      defineTool({
        name: 'lookup',
        input: z.object({ query: z.string() }),
        output: z.string(),
        execute: (_sandbox, { query }) => {
          executions += 1;

          return query;
        },
      })(undefined as never),
    ]);

    const provider = createProvider({
      complete: () =>
        completeFinish('', [call('lookup', { query: 42 }, callId)]),
      stream: () =>
        streamEvents(
          completeFinish('', [call('lookup', { query: 42 }, callId)]),
        ),
    });
    const messages = createMessageStorage();

    const agent = createAgent({
      provider: provider.provider,
      tools,
      messages,
      system: '',
      model: 'fake-model',
    });

    await assert.rejects(
      invoke(agent, mode, { maxToolCallRepairs: 0 }),
      (error: unknown) =>
        error instanceof ToolErrorObject &&
        error.data.code === 'invalid_payload',
    );

    assert.equal(executions, 0);

    assertIncomplete(messages, callId);
  });
}
