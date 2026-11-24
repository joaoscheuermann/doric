// A source stream a test drives (phase 3, S60d): the server-streaming fake of
// one workspace stream (`runtime/v2.WatchProject`,
// `runtime.threads/v1.WatchThread`, `terminal/v1.WatchProject`) whose items,
// failure and end the test pushes, and which reports when it was opened (with
// its request) and when its call ended (the consumer stopped reading or the
// call's signal aborted).

import type { JsonValue } from '@bufbuild/protobuf';
import { callOf } from 'bundle/contracts';

import type { StreamFake } from './router-fakes.js';

type Entry =
  | { readonly kind: 'item'; readonly item: JsonValue }
  | { readonly kind: 'error'; readonly error: Error }
  | { readonly kind: 'end' };

export interface Source {
  /** The fake to pass as one of `Streams`. */
  readonly fake: StreamFake;
  /** Sends one item (proto JSON of the stream's response message). */
  push(item: JsonValue): void;
  /** Ends the stream with `error`. */
  fail(error: Error): void;
  /** Ends the stream without error. */
  end(): void;
  /** Resolves with the request (proto JSON) of the first opening. */
  readonly opened: Promise<JsonValue>;
  /** Resolves once an opening's call ended (finished, failed or cancelled). */
  readonly closed: Promise<void>;
  /** How many times the stream was opened. */
  openings(): number;
}

/** A stream the test drives; items pushed before it opens wait for it. */
export const source = (): Source => {
  const queue: Entry[] = [];
  let wake: (() => void) | undefined;
  let count = 0;
  let resolveOpened: (request: JsonValue) => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const opened = new Promise<JsonValue>((resolve) => {
    resolveOpened = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const put = (entry: Entry) => {
    queue.push(entry);
    wake?.();
  };

  /** The next entry, or `undefined` once `signal` aborts. */
  const take = (signal: AbortSignal): Promise<Entry | undefined> =>
    new Promise((resolve) => {
      const settle = () => {
        wake = undefined;
        signal.removeEventListener('abort', settle);
        resolve(signal.aborted ? undefined : queue.shift());
      };

      if (signal.aborted || queue.length > 0) {
        settle();
        return;
      }

      wake = settle;
      signal.addEventListener('abort', settle, { once: true });
    });

  return {
    fake: async function* (request, context) {
      count += 1;
      resolveOpened(request);
      const { signal } = callOf(context);

      try {
        for (;;) {
          const entry = await take(signal);

          if (entry === undefined || entry.kind === 'end') return;
          if (entry.kind === 'error') throw entry.error;
          yield entry.item;
        }
      } finally {
        resolveClosed();
      }
    },
    push: (item) => put({ kind: 'item', item }),
    fail: (error) => put({ kind: 'error', error }),
    end: () => put({ kind: 'end' }),
    opened,
    closed,
    openings: () => count,
  };
};
