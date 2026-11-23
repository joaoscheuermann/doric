// Listener-based sources as server streams (phase 3, slice S46a), on the
// pattern of core's `createInbox`.

import type { Disposable } from 'bundle/contracts';

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
