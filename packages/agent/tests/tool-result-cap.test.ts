import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import { createMessageStorage } from 'messages';
import { isRecord, type ToolStorage } from 'tool';

import {
  type AgentRunOptions,
  createAgent,
  createToolCallStorage,
} from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTools,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';

/** 26 characters: what every tool answers, as its result or as its failure's message. */
const OUTPUT = 'abcdefghijklmnopqrstuvwxyz';
/** `OUTPUT` held to 10 characters, as the model reads it. */
const CAPPED = 'abcdefghij\n… [truncated 16 of 26 characters]';

/** Each tool answers `OUTPUT`, or throws it when its call asks to fail. */
const tools: ToolStorage = {
  ...createTools().storage,
  execute: async (toolCall) => {
    const payload =
      'payload' in toolCall ? toolCall.payload : JSON.parse(toolCall.arguments);
    if (isRecord(payload) && payload.fail === true) throw new Error(OUTPUT);
    return OUTPUT;
  },
};

/** One result and one failure of each tool, in a single batch. */
const batch = [
  call('big', {}, 'big_result'),
  call('big', { fail: true }, 'big_failure'),
  call('small', {}, 'small_result'),
  call('small', { fail: true }, 'small_failure'),
];

const runBatch = async (
  mode: Mode,
  maxToolResultChars: AgentRunOptions['maxToolResultChars'],
) => {
  const answer = (index: number) =>
    index === 0 ? completeFinish('', batch) : completeFinish('Done.');
  const provider = createProvider({
    complete: (_request, index) => answer(index),
    stream: (_request, index) => streamEvents(answer(index)),
  });
  const toolCalls = createToolCallStorage();
  const agent = createAgent({
    provider: provider.provider,
    tools,
    messages: createMessageStorage(),
    toolCalls,
    system: '',
    model: 'fake-model',
  });

  if (mode === 'complete')
    await agent.complete('Start.', { maxToolResultChars });
  else await collect(agent.stream('Start.', { maxToolResultChars }));

  assert.equal(provider.requests.length, 2);
  return { next: provider.requests[1], records: toolCalls.list() };
};

/** The text the request carries as the answer to one call. */
const answerTo = (
  request: ProviderRequest<unknown> | undefined,
  callId: string,
): string => {
  const content = request?.messages.find(
    (message) => message.role === 'tool' && message.toolCallId === callId,
  )?.content;
  assert.equal(typeof content, 'string', `no answer to ${callId}`);
  return content as string;
};

const assertCapped = (text: string) => {
  assert.ok(text.includes(CAPPED), text);
  assert.ok(!text.includes(OUTPUT), text);
};

const assertWhole = (text: string) => {
  assert.ok(text.includes(OUTPUT), text);
  assert.ok(!text.includes('[truncated'), text);
};

for (const mode of ['complete', 'stream'] as const) {
  void test(`${mode}: a numeric cap holds every tool result and failure the next request carries`, async () => {
    const { next, records } = await runBatch(mode, 10);

    for (const callId of batch.map((request) => request.id))
      assertCapped(answerTo(next, callId));
    assert.deepEqual(
      records.map((record) => [record.callId, record.output]),
      [
        ['big_result', OUTPUT],
        ['small_result', OUTPUT],
      ],
    );
  });

  void test(`${mode}: a cap function caps each tool by its name, and undefined leaves it whole`, async () => {
    const { next, records } = await runBatch(mode, (toolName) =>
      toolName === 'big' ? undefined : 10,
    );

    assertWhole(answerTo(next, 'big_result'));
    assertWhole(answerTo(next, 'big_failure'));
    assertCapped(answerTo(next, 'small_result'));
    assertCapped(answerTo(next, 'small_failure'));
    assert.deepEqual(
      records.map((record) => record.output),
      [OUTPUT, OUTPUT],
    );
  });
}
