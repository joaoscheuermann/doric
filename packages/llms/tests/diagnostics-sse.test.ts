import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnosticExcerpt, parseSseEvents } from '../src/index.js';
import { collect } from './fakes.js';

test('bounds diagnostic excerpts without changing their content', () => {
  const content = 'provider output';

  assert.equal(diagnosticExcerpt(content, content.length), content);
  assert.equal(diagnosticExcerpt(content, 8), 'provider...[truncated]');
  assert.equal(
    diagnosticExcerpt('sk-fake123 Bearer fake-token'),
    'sk-fake123 Bearer fake-token',
  );
});

test('parses SSE comments chunk boundaries multi-line data and done markers', async () => {
  const events = await collect(
    parseSseEvents(
      (async function* () {
        yield ': comment\n';
        yield 'event: message\ndata: first\n';
        yield 'data: second\n\n';
        yield 'data: [DONE]\n\n';
      })(),
    ),
  );

  assert.deepEqual(events, [
    { event: 'message', data: 'first\nsecond', done: false },
    { event: undefined, data: '[DONE]', done: true },
  ]);
});
