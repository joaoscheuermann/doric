import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnosticExcerpt, parseSseEvents } from '../src/index.js';
import { collect } from './fakes.js';

test('redacts and truncates diagnostic excerpts', () => {
  const excerpt = diagnosticExcerpt(`sk-testSecret123 ${'x'.repeat(20)}`, 16);

  assert.equal(excerpt, 'sk-[redacted] xx...[truncated]');
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
