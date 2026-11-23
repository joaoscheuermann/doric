// Listener-based sources as server streams (phase 3, slice S46a), on the
// pattern of core's `createInbox`. S47a folds the stream wrappers of
// `rpc/runtime.ts`, `rpc/threads.ts` and `rpc/attachments.ts` here.

import type { Disposable } from 'bundle/contracts';

import { detached, routedError } from './errors.js';

/** What a listener-based source pushes to one open stream. */
export interface StreamSink<T> {
  next(item: T): void;
  /** Ends the stream: done without `error`, failed with it. Later calls are ignored. */
  end(error?: unknown): void;
}

/**
 * The items `open` pushes, as an async iterable for a server-streaming
 * handler.
 * - `open(sink)` is called once, at the first `next()`. Items are yielded in
 *   push order, and none is dropped (an unbounded queue, as the kernel's
 *   socket today; §8 G4).
 * - Iteration ends when `sink.end()` is called, rejecting with its error if
 *   given (unchanged: the handler's `ContractError` reaches the caller), or
 *   when `signal` aborts (returns, no error).
 * - The answered `Disposable` is disposed exactly once on every exit: end,
 *   abort, a consumer `return`, or a throw from `open`. An `open` that throws
 *   rejects the first `next()` with that error.
 */
export const streamOf = <T>(
  open: (sink: StreamSink<T>) => Disposable,
  signal: AbortSignal,
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    const items: T[] = [];
    let ended: { readonly error?: unknown } | undefined;
    let wake: (() => void) | undefined;
    const rouse = () => {
      wake?.();
      wake = undefined;
    };
    const sink: StreamSink<T> = {
      next: (item) => {
        if (ended !== undefined) return;
        items.push(item);
        rouse();
      },
      end: (error) => {
        if (ended !== undefined) return;
        ended = error === undefined ? {} : { error };
        rouse();
      },
    };
    signal.addEventListener('abort', rouse, { once: true });
    let opened: Disposable | undefined;
    try {
      opened = open(sink);
      for (;;) {
        if (signal.aborted) return;
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (ended !== undefined) {
          if ('error' in ended) throw ended.error;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener('abort', rouse);
      opened?.dispose();
    }
  },
});

/**
 * Yields every item of `source()`, in order. Any failure, thrown by `source()`
 * itself or by its iteration, is rethrown as `routedError` reads it, so a
 * `ContractError` reaches the caller unchanged and a routed `ConnectError`
 * keeps its Doric code. A consumer `return` (the call cancelled) closes
 * `source`'s iterator. Never yields after a failure.
 */
export async function* routedItems<T>(
  source: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    yield* source();
  } catch (error) {
    throw routedError(error);
  }
}

/**
 * `routedItems(() => streamOf(sink => detached(() => open(sink)), signal))`:
 * a listener-based server stream whose `open` runs outside the incoming call
 * (S46a's convention), ending when `signal` aborts. Replaces the `items`
 * helpers of `rpc/runtime.ts` and `rpc/threads.ts` (callers encode each item
 * themselves).
 */
export const detachedItems = <T>(
  open: (sink: StreamSink<T>) => Disposable,
  signal: AbortSignal,
): AsyncGenerator<T> =>
  routedItems(() => streamOf<T>((sink) => detached(() => open(sink)), signal));
