import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import { createMessageStorage } from 'messages';

import {
  type AgentToolEvent,
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

/** 26 characters: what the tool answers. */
const OUTPUT = 'abcdefghijklmnopqrstuvwxyz';
/** `OUTPUT` kept to 10 characters, as a record cut at 10 holds it. */
const CUT = 'abcdefghij\n… [truncated 16 of 26 characters]';

const runOneCall = async (mode: Mode, maxRecordOutputChars?: number) => {
  const answer = (index: number) =>
    index === 0
      ? completeFinish('', [call('lookup', {}, 'lookup_1')])
      : completeFinish('Done.');
  const provider = createProvider({
    complete: (_request, index) => answer(index),
    stream: (_request, index) => streamEvents(answer(index)),
  });
  const toolCalls = createToolCallStorage();
  const finished: string[] = [];
  const agent = createAgent({
    provider: provider.provider,
    tools: createTools({ results: { lookup: OUTPUT } }).storage,
    messages: createMessageStorage(),
    toolCalls,
    system: '',
    model: 'fake-model',
    ...(maxRecordOutputChars === undefined ? {} : { maxRecordOutputChars }),
  });
  const onToolEvent = (event: AgentToolEvent) => {
    if (event.type === 'tool.finished') finished.push(event.record.output);
  };

  if (mode === 'complete') await agent.complete('Start.', { onToolEvent });
  else await collect(agent.stream('Start.', { onToolEvent }));

  assert.equal(provider.requests.length, 2);
  return {
    stored: toolCalls.list().map((record) => record.output),
    finished,
    next: provider.requests[1],
  };
};

/** The text the request carries as the answer to `lookup_1`. */
const answer = (request: ProviderRequest<unknown> | undefined): string => {
  const content = request?.messages.find(
    (message) => message.role === 'tool' && message.toolCallId === 'lookup_1',
  )?.content;
  assert.equal(typeof content, 'string', 'no answer to lookup_1');
  return content as string;
};

for (const mode of ['complete', 'stream'] as const) {
  void test(`${mode}: a record keeps at most maxRecordOutputChars of the output, cut with the marker`, async () => {
    const { stored, finished, next } = await runOneCall(mode, 10);

    assert.deepEqual(stored, [CUT]);
    assert.deepEqual(finished, [CUT]);
    assert.ok(answer(next).includes(CUT), answer(next));
    assert.ok(!answer(next).includes(OUTPUT), answer(next));
  });

  void test(`${mode}: an output of exactly maxRecordOutputChars is kept whole`, async () => {
    const { stored } = await runOneCall(mode, OUTPUT.length);

    assert.deepEqual(stored, [OUTPUT]);
  });

  void test(`${mode}: without maxRecordOutputChars the record keeps the whole output`, async () => {
    const { stored, finished } = await runOneCall(mode);

    assert.deepEqual(stored, [OUTPUT]);
    assert.deepEqual(finished, [OUTPUT]);
  });
}
