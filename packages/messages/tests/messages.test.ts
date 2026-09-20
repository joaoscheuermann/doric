import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderFinished, ProviderMessage, ProviderRequest } from 'llms';

import {
  createMessageStorage,
  type MessageStorageEntry,
} from '../src/index.js';

test('preserves initial order and returns defensive snapshots', () => {
  const initial: readonly ProviderMessage[] = [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Draft a plan.' },
  ];
  const storage = createMessageStorage(initial);
  const first = storage.list();
  const secondLength = storage.push({ role: 'assistant', content: 'Done.' });
  const second = storage.list();

  (first as ProviderMessage[]).push({ role: 'user', content: 'mutated' });

  assert.equal(secondLength, 3);

  assert.deepEqual(first, [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Draft a plan.' },
    { role: 'user', content: 'mutated' },
  ]);

  assert.deepEqual(second, [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Draft a plan.' },
    { role: 'assistant', content: 'Done.' },
  ]);

  assert.deepEqual(storage.list(), second);
});

test('copies initial messages before caller-owned arrays can be mutated', () => {
  const initial: ProviderMessage[] = [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Draft a plan.' },
  ];
  const storage = createMessageStorage(initial);

  initial.push({ role: 'assistant', content: 'Caller mutation.' });

  assert.deepEqual(storage.list(), [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: 'Draft a plan.' },
  ]);
});

test('stores provider messages and returns the new length', () => {
  const storage = createMessageStorage();

  const message: ProviderMessage = {
    role: 'tool',
    toolCallId: 'call_1',
    content: 'result',
  };

  assert.equal(storage.push(message), 1);

  assert.deepEqual(storage.list(), [message]);
});

test('normalizes finished turns with text and tool calls into assistant messages', () => {
  const storage = createMessageStorage();

  const finish: ProviderFinished = {
    text: 'I will call a tool.',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: 'call_1',
        name: 'lookup',
        arguments: '{"query":"doric"}',
        index: 0,
      },
    ],
  };

  assert.equal(storage.push(finish), 1);

  assert.deepEqual(storage.list(), [
    {
      role: 'assistant',
      content: 'I will call a tool.',
      toolCalls: finish.toolCalls,
    },
  ]);
});

test('uses refusal as assistant content when finished text is empty', () => {
  const storage = createMessageStorage();

  storage.push({
    text: '',
    finishReason: 'content_filter',
    refusal: 'I cannot help with that.',
    toolCalls: [],
  });

  assert.deepEqual(storage.list(), [
    {
      role: 'assistant',
      content: 'I cannot help with that.',
    },
  ]);
});

test('omits public reasoning metadata while preserving opaque provider replay', () => {
  const storage = createMessageStorage();

  storage.push({
    text: 'Final answer.',
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      reasoningTokens: 2,
    },
    reasoning: {
      text: 'Private reasoning.',
      effort: 'low',
      summary: 'Concise summary.',
    },
    replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
    toolCalls: [],
  });

  assert.deepEqual(storage.list(), [
    {
      role: 'assistant',
      content: 'Final answer.',
      replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
    },
  ]);
});

test('accepts message lists as provider request messages', () => {
  const storage = createMessageStorage([{ role: 'user', content: 'Hello.' }]);

  const request = {
    model: 'test-model',
    messages: storage.list(),
  } satisfies ProviderRequest;
  const entry: MessageStorageEntry = request.messages[0];

  assert.equal(entry.role, 'user');
});
