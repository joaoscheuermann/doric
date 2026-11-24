// A listener-based source as a server stream (phase 3, S59 §2.9), a copy of
// `chat`'s `streamOf`.

import type { Disposable } from 'bundle/contracts';

/** What a listener-based source pushes into one open stream. */
export interface StreamSink<T> {
  next(item: T): void;
}

/**
 * The items `open` pushes, as the async iterable a server-streaming handler returns. `open(sink)` runs at the first
 * `next()`; items are yielded in push order, none dropped (unbounded queue). Iteration ends, returning, when `signal`
 * aborts or the consumer returns (a cancelled call); the `Disposable` `open` answered is disposed exactly once on
 * every exit. An `open` that throws rejects the first `next()` with that error.
 */
export const streamOf = <T>(
  open: (sink: StreamSink<T>) => Disposable,
  signal: AbortSignal,
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    const items: T[] = [];
    let wake: (() => void) | undefined;
    const rouse = () => {
      wake?.();
      wake = undefined;
    };
    const sink: StreamSink<T> = {
      next: (item) => {
        items.push(item);
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
