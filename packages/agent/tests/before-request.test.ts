import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMessage, ProviderRequest } from 'llms';
import { createMessageStorage } from 'messages';
import type { ToolDefinition, ToolStorage } from 'tool';

import type { Agent, AgentEvent, AgentRunOptions } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createTestAgent as createAgent,
  createProvider,
  createTools,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';

const createHarness = (
  answer: (index: number) => ReturnType<typeof completeFinish>,
  tools: ToolStorage = createTools({
    results: { lookup: { found: true }, read: 'contents' },
  }).storage,
) => {
  const provider = createProvider({
    complete: (_request, index) => answer(index),
    stream: (_request, index) => streamEvents(answer(index)),
  });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: provider.provider,
    tools,
    messages,
    system: '',
    model: 'fake-model',
  });
  return { agent, messages, provider };
};

/** Runs one mode to its end and returns its text and every event it streamed. */
const run = async (
  agent: Agent,
  mode: Mode,
  options: AgentRunOptions,
): Promise<{
  readonly text: string;
  readonly events: readonly AgentEvent[];
}> => {
  if (mode === 'complete') {
    const response = await agent.complete('Start.', options);
    return { text: response.text, events: [] };
  }
  const events = await collect(agent.stream('Start.', options));
  const finished = events.find((event) => event.type === 'agent.finished');
  return {
    text: finished?.type === 'agent.finished' ? finished.response.text : '',
    events,
  };
};

/** A caller callback that answers `reply(n)` on its n-th call (from 0) and counts its calls. */
const createBeforeRequest = (
  reply: (index: number) => readonly string[] = () => ['ctx'],
) => {
  let calls = 0;
  return {
    calls: () => calls,
    beforeRequest: async () => reply(calls++),
  };
};

const ctx: ProviderMessage = { role: 'user', content: 'ctx' };

/** Each stored turn as its role and its text, or the call it answers for a tool result. */
const conversation = (messages: readonly ProviderMessage[]) =>
  messages
    .filter((message) => message.role !== 'system')
    .map((message) =>
      message.role === 'tool'
        ? `tool:${message.toolCallId ?? ''}`
        : `${message.role}:${typeof message.content === 'string' ? message.content : ''}`,
    );

const lastMessage = (request: ProviderRequest<unknown> | undefined) =>
  request?.messages.at(-1);

for (const mode of ['complete', 'stream'] as const) {
  void test(`${mode}: beforeRequest messages end every provider request and stay in the history`, async () => {
    const callback = createBeforeRequest();
    const harness = createHarness((index) =>
      index === 0
        ? completeFinish('', [call('lookup')])
        : completeFinish('Done.'),
    );

    const result = await run(harness.agent, mode, {
      beforeRequest: callback.beforeRequest,
    });

    assert.equal(result.text, 'Done.');
    assert.equal(harness.provider.requests.length, 2);
    for (const request of harness.provider.requests)
      assert.deepEqual(lastMessage(request), ctx);
    assert.equal(callback.calls(), harness.provider.requests.length);
    assert.deepEqual(conversation(harness.messages.list()), [
      'user:Start.',
      'user:ctx',
      'assistant:',
      'tool:call_lookup',
      'user:ctx',
      'assistant:Done.',
    ]);
  });

  void test(`${mode}: a beforeRequest message follows every result of a tool batch`, async () => {
    const callback = createBeforeRequest((index) =>
      index === 0 ? [] : ['ctx'],
    );
    const harness = createHarness((index) =>
      index === 0
        ? completeFinish('', [call('lookup'), call('read')])
        : completeFinish('Done.'),
    );

    await run(harness.agent, mode, { beforeRequest: callback.beforeRequest });

    const tail = harness.provider.requests[1]?.messages.slice(-4) ?? [];
    assert.deepEqual(
      tail.map((message) => message.role),
      ['assistant', 'tool', 'tool', 'user'],
    );
    assert.deepEqual(
      tail[0]?.toolCalls?.map((toolCall) => toolCall.id),
      ['call_lookup', 'call_read'],
    );
    assert.deepEqual(
      tail.slice(1, 3).map((message) => message.toolCallId),
      ['call_lookup', 'call_read'],
    );
    assert.deepEqual(tail[3], ctx);
  });

  void test(`${mode}: a final tool-less answer is not followed by beforeRequest or another request`, async () => {
    const callback = createBeforeRequest();
    const harness = createHarness(() => completeFinish('Answered.'));

    const result = await run(harness.agent, mode, {
      beforeRequest: callback.beforeRequest,
    });

    assert.equal(result.text, 'Answered.');
    assert.equal(harness.provider.requests.length, 1);
    assert.equal(callback.calls(), 1);
    assert.deepEqual(harness.messages.list().at(-1), {
      role: 'assistant',
      content: 'Answered.',
    });
    assert.equal(
      result.events.some((event) => event.type === 'agent.steered'),
      false,
    );
  });

  void test(`${mode}: a tool that beforeRequest makes visible is offered in that same request`, async () => {
    let unlocked = false;
    const late: ToolDefinition = {
      name: 'late',
      inputSchema: { type: 'object' },
      outputSchema: {},
    };
    const tools = createTools().storage;
    const harness = createHarness(() => completeFinish('Done.'), {
      ...tools,
      definitions: () => (unlocked ? [late] : []),
    });

    await run(harness.agent, mode, {
      beforeRequest: () => {
        unlocked = true;
        return [];
      },
    });

    assert.equal(harness.provider.requests.length, 1);
    assert.deepEqual(
      harness.provider.requests[0]?.tools?.map((tool) => tool.name),
      ['late'],
    );
  });

  void test(`${mode}: a rejected beforeRequest ends the run with its error`, async () => {
    const failure = new Error('context unavailable');
    const harness = createHarness(() => completeFinish('Never.'));
    const options: AgentRunOptions = {
      beforeRequest: () => Promise.reject(failure),
    };

    await assert.rejects(run(harness.agent, mode, options), (error) => {
      assert.equal(error, failure);
      return true;
    });
    assert.equal(harness.provider.requests.length, 0);
  });
}
