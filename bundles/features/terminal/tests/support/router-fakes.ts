// Pieces of the router harness (`./router.ts`) of `terminal`'s host part
// (phase 3, S54b): the fake of `runtime.lease/v1.Start`, which answers
// `started`, then output and exit when the test says so, and records the
// `write` and `resize` items; and the small stream helpers the fakes share.

import {
  type DescService,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  type CallScope,
  type ContractError,
  deadlineOf,
} from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';
import {
  LeaseService,
  StartHeadSchema,
  type StartResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

/** One `Start` stream, driven by the test. */
export interface FakeProcess {
  /** The head as JSON (`StartHead`, fields at their default left out). */
  readonly head: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf` of the call, 0 when none. */
  readonly deadline: number;
  /** The call's signal: aborted when the caller cancels `Start`. */
  readonly signal: AbortSignal;
  readonly writes: string[];
  readonly resizes: { readonly cols: number; readonly rows: number }[];
  /** Sends one `output` item. */
  output(stream: 'stdout' | 'stderr', data: string): void;
  /** Sends the `exit` item and ends the call; `exitCode` absent stays absent. */
  exit(result?: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }): void;
  /** Fails the call with `error` after `started`. */
  fail(error: ContractError): void;
}

type StartItem = MessageInitShape<typeof StartResponseSchema>;

/** A `[Service, implementation]` fake that serves only the methods given. */
export const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** An unbounded async queue a fake drains; `close` ends it. */
export const channel = <T>() => {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  return {
    push: (item: T) => {
      items.push(item);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const item = items.shift();

        if (item !== undefined) {
          yield item;
          continue;
        }

        if (closed) return;

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
};

/** Resolves when `signal` aborts. */
export const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const exitItem = (result: {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}): StartItem => {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  return {
    item: {
      case: 'exit',
      value: {
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        stdout,
        stderr,
        stdoutBytes: new TextEncoder().encode(stdout),
        stderrBytes: new TextEncoder().encode(stderr),
      },
    },
  };
};

/**
 * The `LeaseService` fake: `Start` reads the head, records it through
 * `record` (`lease.start`), fails with `startError` when given, else pushes a
 * {@link FakeProcess} to `processes`, answers `started` and then what the
 * test sends. Its cancellation is `lease.cancelled` in `timeline`.
 */
export const leaseFake = (options: {
  readonly startError?: ContractError;
  readonly record: (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ) => Call;
  readonly processes: FakeProcess[];
  readonly timeline: string[];
}): ServiceEntry =>
  fakeOf(LeaseService, {
    start: async function* (requests, context) {
      const iterator = requests[Symbol.asyncIterator]();
      const first = await iterator.next();
      const head =
        !first.done && first.value.item.case === 'head'
          ? toJson(StartHeadSchema, first.value.item.value)
          : null;
      const call = options.record('lease.start', head, context);

      if (options.startError !== undefined) throw options.startError;

      const items = channel<StartItem | ContractError>();
      const process: FakeProcess = {
        head,
        scope: call.scope,
        deadline: deadlineOf(call),
        signal: context.signal,
        writes: [],
        resizes: [],
        output: (stream, data) =>
          items.push({ item: { case: 'output', value: { stream, data } } }),
        exit: (result = {}) => {
          items.push(exitItem(result));
          items.close();
        },
        fail: (error) => {
          items.push(error);
          items.close();
        },
      };

      void (async () => {
        for (;;) {
          const next = await iterator.next().catch(() => undefined);

          if (next === undefined || next.done) return;

          const { item } = next.value;

          if (item.case === 'write') process.writes.push(item.value);
          if (item.case === 'resize') {
            process.resizes.push({
              cols: item.value.cols,
              rows: item.value.rows,
            });
          }
        }
      })();

      context.signal.addEventListener(
        'abort',
        () => {
          options.timeline.push('lease.cancelled');
          items.close();
        },
        { once: true },
      );
      options.processes.push(process);
      options.timeline.push('lease.started');
      yield { item: { case: 'started', value: {} } };

      for await (const item of items.drain()) {
        if (!('item' in item)) throw item;

        yield item;
      }
    },
  });
