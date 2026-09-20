import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSseEvents } from '../src/lib/utils/sse.js';

const encoder = new TextEncoder();

async function* splitStream(text: string) {
  const bytes = encoder.encode(`data: ready\n\ndata: ${text}\n\n`);
  const split = encoder.encode('data: ready\n\ndata: ').length + 1;
  yield bytes.slice(0, split);
  yield bytes.slice(split);
}

test('decodes split UTF-8 independently in interleaved streams', async () => {
  const first = parseSseEvents(splitStream('😀'))[Symbol.asyncIterator]();
  const second = parseSseEvents(splitStream('é'))[Symbol.asyncIterator]();

  assert.equal((await first.next()).value?.data, 'ready');
  assert.equal((await second.next()).value?.data, 'ready');
  assert.equal((await first.next()).value?.data, '😀');
  assert.equal((await second.next()).value?.data, 'é');
  assert.equal((await first.next()).done, true);
  assert.equal((await second.next()).done, true);
});

test('closing a stream with incomplete UTF-8 does not contaminate another stream', async () => {
  let closed = false;
  const first = parseSseEvents(
    (async function* () {
      try {
        yield* splitStream('😀');
      } finally {
        closed = true;
      }
    })(),
  )[Symbol.asyncIterator]();

  await first.next();
  await first.return?.();
  assert.equal(closed, true);

  const second = parseSseEvents(splitStream('é'))[Symbol.asyncIterator]();
  assert.equal((await second.next()).value?.data, 'ready');
  assert.equal((await second.next()).value?.data, 'é');
  assert.equal((await second.next()).done, true);
});
