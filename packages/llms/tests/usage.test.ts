import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collect,
  createOpenAiProvider,
  fakeTransport,
  response,
} from './fakes.js';

const cases = [
  {
    name: 'reads Responses cached input tokens',
    usage: { input_tokens_details: { cached_tokens: 12 } },
    expected: 12,
  },
  {
    name: 'falls back to Chat Completions cached prompt tokens',
    usage: { prompt_tokens_details: { cached_tokens: 7 } },
    expected: 7,
  },
  {
    name: 'falls back when input details do not report cached tokens',
    usage: {
      input_tokens_details: {},
      prompt_tokens_details: { cached_tokens: 7 },
    },
    expected: 7,
  },
  {
    name: 'prefers Responses cached input tokens when both are present',
    usage: {
      input_tokens_details: { cached_tokens: 12 },
      prompt_tokens_details: { cached_tokens: 7 },
    },
    expected: 12,
  },
  {
    name: 'preserves zero cached input tokens over the fallback',
    usage: {
      input_tokens_details: { cached_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 7 },
    },
    expected: 0,
  },
  {
    name: 'leaves cached input tokens absent when unreported',
    usage: {},
    expected: undefined,
  },
] as const;

for (const { name, usage, expected } of cases) {
  test(`${name} for completion and stream finishes`, async () => {
    const body = { status: 'completed', output_text: 'Done', usage };
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      transport: fakeTransport({
        responses: [response(body)],
        streams: [
          [
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: body,
            })}\n\n`,
          ],
        ],
      }),
    });
    const request = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    } as const;

    const finish = await provider.complete(request);
    assert.equal(finish.usage?.cachedInputTokens, expected);

    const events = await collect(provider.stream(request));
    const finished = events.find((event) => event.type === 'response.finished');
    assert.ok(finished);
    assert.equal(finished.finish.usage?.cachedInputTokens, expected);
  });
}
