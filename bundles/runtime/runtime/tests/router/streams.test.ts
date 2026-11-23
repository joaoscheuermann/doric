// `streamOf` (phase 3, slice S46a, contract §1.3): a listener-based source as
// the async iterable a server-streaming handler answers. Tests 8–9 of the
// slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ContractError, type Disposable } from 'bundle/contracts';

import { type StreamSink, streamOf } from '../../src/host/rpc/streams.js';

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

describe('streamOf', () => {
  test('8: yields pushed items in order, those pushed before the first next() resolves included; open runs once, at the first next()', async () => {
    const pushes = source<string>();
    const stream = streamOf<string>((sink) => {
      const disposable = pushes.open(sink);
      // Pushed while the first `next()` is still pending.
      sink.next('a');
      sink.next('b');

      return disposable;
    }, new AbortController().signal);

    assert.equal(pushes.state.opened, 0, 'nothing opens before iteration');

    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();

    assert.equal(pushes.state.opened, 1);
    assert.deepEqual(await first, { done: false, value: 'a' });

    setTimeout(() => {
      pushes.sink().next('c');
      pushes.sink().end();
    }, 5);

    const rest: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }

    assert.deepEqual(rest, ['b', 'c']);
    assert.equal(pushes.state.opened, 1);
  });

  test('9: end(error) rejects the iteration with that error and disposes once', async () => {
    const pushes = source<string>();
    const failure = new ContractError('replay_failed', 'gone');
    const stream = streamOf<string>(pushes.open, new AbortController().signal);
    const items: string[] = [];
    const iterated = (async () => {
      for await (const item of stream) items.push(item);
    })();

    await tick();
    pushes.sink().next('a');
    pushes.sink().end(failure);
    pushes.sink().next('ignored');

    await assert.rejects(iterated, (error: unknown) => error === failure);
    assert.deepEqual(items, ['a']);
    assert.equal(pushes.state.disposed, 1);
  });

  test('9: end() finishes the iteration and disposes once', async () => {
    const pushes = source<number>();
    const stream = streamOf<number>(pushes.open, new AbortController().signal);
    const items: number[] = [];
    const iterated = (async () => {
      for await (const item of stream) items.push(item);
    })();

    await tick();
    pushes.sink().next(1);
    pushes.sink().end();
    pushes.sink().end(new Error('later calls are ignored'));

    await iterated;
    assert.deepEqual(items, [1]);
    assert.equal(pushes.state.disposed, 1);
  });

  test('9: an abort of the signal ends the iteration without error and disposes once', async () => {
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

  test("9: a consumer's return ends the iteration and disposes once", async () => {
    const pushes = source<number>();
    const stream = streamOf<number>((sink) => {
      const disposable = pushes.open(sink);
      sink.next(1);
      sink.next(2);

      return disposable;
    }, new AbortController().signal);

    for await (const item of stream) {
      assert.equal(item, 1);
      break;
    }

    assert.equal(pushes.state.disposed, 1);
  });

  test('9: an open that throws rejects the first next() with its error', async () => {
    const failure = new ContractError('not_found', 'no such Project');
    const stream = streamOf<number>(() => {
      throw failure;
    }, new AbortController().signal);

    await assert.rejects(
      stream[Symbol.asyncIterator]().next(),
      (error: unknown) => error === failure,
    );
  });
});
