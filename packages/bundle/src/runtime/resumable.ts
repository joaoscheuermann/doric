// Resumable streams (spec `docs/designs/grpc-processes.md`, section 4,
// "Resumable streams"): the caller's side, which opens a stream again when
// its provider instance was lost or began to drain. Browser-safe: shared by
// the host SDK and the client SDK.

import {
  type DescMethodServerStreaming,
  type DescService,
  getOption,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import {
  type CallOptions,
  type Client,
  ConnectError,
} from '@connectrpc/connect';

import { isContractError } from '../contracts/error.js';
import { method as methodOption } from '../contracts/gen/doric/platform/v1/options_pb.js';
import { fromConnectError } from '../contracts/status.js';

/**
 * The delays between two openings of a resumable stream: the first after
 * 100 ms, each next one double the last while the opening answers
 * `unavailable`, never more than 5 s.
 */
export const resumableDelays = { firstMs: 100, maxMs: 5_000 } as const;

/**
 * For each server-streaming method of `S`, by its local name (the key of
 * `S.method`, as `Client<S>` names it): the request that opens the stream
 * again after `last`, the last item the caller received; the `resume` of
 * {@link reopenResumable} for that method. Keys of other methods are not
 * accepted. With `S` the plain `DescService` it accepts no key, so a
 * client of an untyped service reopens with the original request.
 */
export type ResumeRequests<S extends DescService> = {
  readonly [K in keyof S['method'] as S['method'][K] extends DescMethodServerStreaming
    ? K
    : never]?: S['method'][K] extends DescMethodServerStreaming<
    infer I,
    infer O
  >
    ? (last: MessageShape<O>) => MessageInitShape<I>
    : never;
};

/**
 * Iterates a resumable server stream (its method has
 * `(doric.platform.v1.method).resumable = true`) across the instances of
 * its provider. Opens it with `open(request)` when the iteration starts and
 * yields its items in order. When an opening ends with the Doric code
 * `generation_lost` (a `ConnectError` whose `fromConnectError` code it is,
 * or a `ContractError` with that code) — the provider instance was lost or
 * began to drain — it opens the stream again after
 * `resumableDelays.firstMs`, with `resume(last)` when `resume` is given and
 * an item was yielded (`last` the last one), and with `request` otherwise;
 * while an opening ends with `unavailable` before its first item, it tries
 * again after twice the last delay, at most `resumableDelays.maxMs`. The
 * delays start again from the first after an item arrives. The caller's
 * next item after a reopening is the new opening's first, its snapshot.
 *
 * The iteration ends when an opening ends without error, and fails with
 * the error of an opening that ends with any other code, or with
 * `unavailable` on the first opening of the iteration. Stopping the
 * iteration (`break`, `return`) ends the open stream through its
 * iterator's `return` and cancels a pending delay. Nothing is opened
 * before the iteration starts; each iteration opens anew. Only
 * `generation_lost`, and `unavailable` after a reopening, lead to a new
 * opening, as many times as they occur.
 */
export const reopenResumable = <Req, Item>(
  open: (request: Req) => AsyncIterable<Item>,
  request: Req,
  resume?: (last: Item) => Req,
): AsyncIterable<Item> => ({
  [Symbol.asyncIterator]: () => {
    const stopped = new AbortController();
    const inner = iterate(open, request, resume, stopped.signal);

    return {
      next: () => inner.next(),
      return: () => {
        stopped.abort();

        return inner.return(undefined);
      },
    };
  },
});

/**
 * `client`, a Connect client of `service`, with each server-streaming method
 * whose descriptor has `(doric.platform.v1.method).resumable = true`
 * iterated by {@link reopenResumable}: each opening is a call of `client`'s
 * method with the call options of the call, and `resume`'s request for the
 * method reopens it. Their `signal` aborting ends the iteration and cancels
 * a pending reopening. The other methods are `client`'s. Shared by the host
 * SDK's `services.use` and the client SDK's `ClientPart.use`.
 */
export const withResumableStreams = <S extends DescService>(
  service: S,
  client: Client<S>,
  resume: ResumeRequests<S> | undefined,
): Client<S> => {
  const calls: Record<string, unknown> = { ...client };
  // By local name, as `calls`: the methods are read from the descriptor.
  const reopens = (resume ?? {}) as Readonly<
    Record<string, ((last: unknown) => unknown) | undefined>
  >;

  for (const rpc of service.methods) {
    if (
      rpc.methodKind !== 'server_streaming' ||
      !getOption(rpc, methodOption).resumable
    ) {
      continue;
    }

    const open = calls[rpc.localName] as (
      request: unknown,
      options?: CallOptions,
    ) => AsyncIterable<unknown>;

    calls[rpc.localName] = (request: unknown, options?: CallOptions) =>
      untilAborted(
        reopenResumable(
          (next) => open(next, options),
          request,
          reopens[rpc.localName],
        ),
        options?.signal,
      );
  }

  return calls as Client<S>;
};

/**
 * `iterable`, whose iteration `signal` aborting stops as `return` would: a
 * pending reopening of {@link reopenResumable} is cancelled.
 */
const untilAborted = <T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncIterable<T> => {
  if (signal === undefined) {
    return iterable;
  }

  return {
    [Symbol.asyncIterator]: () => {
      const iterator = iterable[Symbol.asyncIterator]();
      const stop = (): void => {
        void iterator.return?.();
      };
      const settled = (): void => {
        signal.removeEventListener('abort', stop);
      };

      signal.addEventListener('abort', stop, { once: true });

      return {
        next: async () => {
          try {
            const result = await iterator.next();

            if (result.done === true) {
              settled();
            }

            return result;
          } catch (error) {
            settled();
            throw error;
          }
        },
        return: async () => {
          settled();

          return (
            (await iterator.return?.()) ?? { done: true, value: undefined }
          );
        },
      };
    },
  };
};

/** The Doric code an opening ended with, `undefined` for a non-Doric error. */
const codeOf = (error: unknown): string | undefined => {
  if (isContractError(error)) {
    return error.code;
  }

  return error instanceof ConnectError
    ? fromConnectError(error).code
    : undefined;
};

/** Resolves after `ms`, or at once when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);

    signal.addEventListener('abort', done, { once: true });
  });

async function* iterate<Req, Item>(
  open: (request: Req) => AsyncIterable<Item>,
  request: Req,
  resume: ((last: Item) => Req) | undefined,
  stopped: AbortSignal,
): AsyncGenerator<Item, void, undefined> {
  let next = request;
  let reopened = false;
  let delay: number = resumableDelays.firstMs;

  for (;;) {
    let received = false;

    try {
      for await (const item of open(next)) {
        received = true;
        next = resume === undefined ? request : resume(item);
        yield item;
      }

      return;
    } catch (error) {
      const code = codeOf(error);

      if (code === 'generation_lost') {
        delay = resumableDelays.firstMs;
      } else if (code === 'unavailable' && reopened && !received) {
        delay = Math.min(delay * 2, resumableDelays.maxMs);
      } else {
        throw error;
      }
    }

    await sleep(delay, stopped);

    if (stopped.aborted) {
      return;
    }

    reopened = true;
  }
}
