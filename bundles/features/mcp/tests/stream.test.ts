// S59 §2.9: `streamOf`, a listener-based source as the async iterable a
// server-streaming handler answers (`mcp/v1.Watch`), a copy of `chat`'s:
// `open` runs at the first `next()`; items come in push order, none dropped;
// the iteration ends when the signal aborts or the consumer returns; the
// source is disposed exactly once on every exit; an `open` that throws
// rejects the first `next()`.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Disposable } from 'bundle/contracts';

import { type StreamSink, streamOf } from '../src/host/stream.js';

/** A source a test pushes into, counting its opens and disposals. */
const source = <T>() => {
  let sink: StreamSink<T> | undefined;
  const state = { opened: 0, disposed: 0 };
  const open = (opened: StreamSink<T>): Disposable => {
    state.opened += 1;
    sink = opened;

    return {
      dispose: () => {
        state.disposed += 1;
      },
    };
  };

  return {
    open,
    state,
    sink: () => {
      assert.ok(sink !== undefined, 'the stream is open');

      return sink;
    },
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

void test('streamOf: open runs once, at the first next(); items come in push order, those pushed during open included', async () => {
  const pushes = source<string>();
  const stream = streamOf<string>((sink) => {
    const disposable = pushes.open(sink);
    sink.next('a');
    sink.next('b');

    return disposable;
  }, new AbortController().signal);

  assert.equal(pushes.state.opened, 0, 'nothing opens before iteration');

  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();

  assert.equal(pushes.state.opened, 1);
  assert.deepEqual(await first, { done: false, value: 'a' });
  assert.deepEqual(await iterator.next(), { done: false, value: 'b' });

  setTimeout(() => pushes.sink().next('c'), 5);

  assert.deepEqual(await iterator.next(), { done: false, value: 'c' });
  assert.equal(pushes.state.opened, 1);
  await iterator.return?.();
});

void test('streamOf: an abort of the signal ends the iteration without error and disposes once', async () => {
  const pushes = source<number>();
  const controller = new AbortController();
  const stream = streamOf<number>(pushes.open, controller.signal);
  const items: number[] = [];
  const iterated = (async () => {
    for await (const item of stream) items.push(item);
  })();

  await tick();
  pushes.sink().next(1);
  await tick();
  controller.abort();

  await iterated;
  assert.deepEqual(items, [1]);
  assert.equal(pushes.state.disposed, 1);
});

void test('streamOf: the consumer returning (a cancelled call) disposes once', async () => {
  const pushes = source<number>();
  const stream = streamOf<number>(pushes.open, new AbortController().signal);
  const items: number[] = [];

  setTimeout(() => {
    pushes.sink().next(1);
    pushes.sink().next(2);
  }, 5);
  for await (const item of stream) {
    items.push(item);
    if (item === 1) break;
  }

  assert.deepEqual(items, [1]);
  assert.equal(pushes.state.disposed, 1);
});

void test('streamOf: an open that throws rejects the first next() with its error', async () => {
  const failure = new Error('cannot subscribe');
  const stream = streamOf<number>(() => {
    throw failure;
  }, new AbortController().signal);

  await assert.rejects(
    stream[Symbol.asyncIterator]().next(),
    (error: unknown) => error === failure,
  );
});
