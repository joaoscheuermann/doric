import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openAiBody,
  openRouterBody,
  type ProviderMessage,
} from '../src/index.js';

const cat = 'data:image/png;base64,iVBORw0KGgo=';
const dog = 'data:image/jpeg;base64,/9j/4AAQ';

const call = (id: string) => ({ id, name: 'view-image', arguments: '{}' });

void test('OpenAI keeps the text and images of a user turn in the order written', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Before.' },
            { type: 'image', imageUrl: cat },
            { type: 'text', text: 'After.' },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Before.' },
        { type: 'input_image', image_url: cat },
        { type: 'input_text', text: 'After.' },
      ],
    },
  ]);
});

void test('OpenAI answers a tool call with its images as input parts', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Look at it.' },
        { role: 'assistant', toolCalls: [call('call_1')] },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'cat.png' },
            { type: 'image', imageUrl: cat },
          ],
        },
      ],
    },
    false,
  );

  const input = body.input as readonly Record<string, unknown>[];
  assert.deepEqual(input.at(-1), {
    type: 'function_call_output',
    call_id: 'call_1',
    output: [
      { type: 'input_text', text: 'cat.png' },
      { type: 'input_image', image_url: cat },
    ],
  });
});

void test('OpenRouter sends a user turn with images as ordered content parts', () => {
  const body = openRouterBody(
    {
      model: 'openai/gpt-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Before.' },
            { type: 'image', imageUrl: cat },
            { type: 'text', text: 'After.' },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Before.' },
        { type: 'image_url', image_url: { url: cat } },
        { type: 'text', text: 'After.' },
      ],
    },
  ]);
});

void test('OpenRouter follows a run of tool results with the images they returned', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Compare them.' },
    { role: 'assistant', toolCalls: [call('call_1'), call('call_2')] },
    {
      role: 'tool',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: 'cat.png' },
        { type: 'image', imageUrl: cat },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_2',
      content: [
        { type: 'text', text: 'dog.jpg' },
        { type: 'image', imageUrl: dog },
      ],
    },
    { role: 'assistant', content: 'They differ.' },
  ];

  const sent = openRouterBody({ model: 'openai/gpt-5', messages }, false)
    .messages as readonly Record<string, unknown>[];

  assert.deepEqual(
    sent.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool', 'user', 'assistant'],
  );
  assert.equal(sent[2]?.content, 'cat.png');
  assert.equal(sent[3]?.content, 'dog.jpg');

  const returned = sent[4]?.content as readonly Record<string, unknown>[];
  const urls = returned
    .filter((part) => part.type === 'image_url')
    .map((part) => (part.image_url as { url: string }).url);
  assert.deepEqual(urls, [cat, dog]);
  const labels = returned
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text));
  assert.match(labels[0] ?? '', /call_1/u);
  assert.match(labels[1] ?? '', /call_2/u);
});
