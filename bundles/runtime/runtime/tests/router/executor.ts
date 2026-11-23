// The fake `executor/v1` provider of runtime's router tests (phase 3, slice
// S48b, contract §5 "Harness"). It serves `ExecutorService` over the domain
// tests' `scriptedExecutor` (`../support/executor.ts`): each request becomes
// the domain input, whose `PromptSession` is `runtime/executor`'s
// `remotePromptSession` (S51b), calling back through `executor.session/v1` as
// the executor's provider would (caller `executorCaller`). A `HistoryPatch`
// answer travels as `historyPatchItems`. It records every call it receives
// and every session call it makes.

import type {
  DescMessage,
  JsonValue,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { type Caller, type CallScope, callOf } from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';

import type {
  CompactionPolicyValue,
  Executor,
  ExecutorThread,
  PromptJob,
} from '../../src/contracts/executor.js';
import type {
  RecordRequestSchema,
  SessionService,
} from '../../src/contracts/gen/doric/executor/session/v1/session_pb.js';
import {
  CheckpointRequestSchema,
  CompactionPolicyValueSchema,
  CompactRequestSchema,
  CompactResponseSchema,
  ExecutorService,
  ExecutorThreadSchema,
  PromptJobSchema,
  RewindRequestSchema,
  RunRequestSchema,
} from '../../src/contracts/gen/doric/executor/v1/executor_pb.js';
import {
  historyPatchItems,
  type RemotePromptSession,
  remotePromptSession,
} from '../../src/executor.js';
import { decode, encode, runtimeOneofs } from '../../src/host/rpc/codec.js';
import {
  type Script,
  scriptedExecutor,
  testHistoryFormat,
} from '../support/executor.js';

/** `default`, the executor's provider, as the router stamps its callbacks. */
export const executorCaller: Caller = {
  bundleId: 'default',
  version: '0.0.0',
  generation: 1,
};

/** One `executor/v1` call the fake received. */
export interface ExecutorCall {
  /** `run`, `checkpoint`, `rewind`, `compact` or `formats`. */
  readonly method: string;
  /** The request as today's JSON (`decode` with `runtimeOneofs`). */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  readonly signal: AbortSignal;
  /** The `WatchCancel` the fake opened for this `Run` or `Compact` (`watchCancel` option); absent otherwise. */
  watch?: CancelWatch;
}

/** One `executor.session/v1.WatchCancel` the fake opened, and what it answered. */
export interface CancelWatch {
  /** Aborted once the stream answered its item; the run's or compaction's signal follows it. */
  readonly cancelled: AbortSignal;
  /** The items the stream answered so far. */
  readonly items: () => number;
  /** Whether the stream ended (OK or failed). */
  readonly done: () => boolean;
  /** Resolves once the stream ended: `{ok: true}`, or `{ok: false, error}`. Never rejects. */
  readonly ended: Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  >;
}

/** One `executor.session/v1` call the fake made back. */
export interface SessionTraffic {
  readonly method: 'readHistory' | 'record';
  readonly sessionId: string;
  readonly part?: string;
  /** The format `ReadHistory`'s head carried. */
  readonly format?: string;
  /** The byte size of each chunk sent or received. */
  readonly chunks: readonly number[];
}

export type ExecutorMethod = keyof ServiceImpl<typeof ExecutorService>;

export interface FakeExecutorOptions {
  /** One prompt run; finishes with 'done' by default. */
  readonly execute?: Script;
  /** What `Formats` answers; the test format by default. */
  readonly formats?: readonly string[];
  /** The scripted executor's `compact`. */
  readonly compact?: Executor['compact'];
  /** Methods answered by the test in place of the scripted executor (still recorded). */
  readonly overrides?: Partial<ServiceImpl<typeof ExecutorService>>;
  /**
   * S51e: the fake opens `WatchCancel{sessionId}` in each scripted `Run` and `Compact` (as
   * `serveExecutor` does) and aborts the script's signal when it answers its item; off by default (an
   * executor that ignores the cancel). The fake never cancels the stream itself: `runtime` ends it.
   */
  readonly watchCancel?: boolean;
  /** Awaited before the fake opens `WatchCancel` (the script runs meanwhile): a late watch. */
  readonly watchCancelAfter?: () => Promise<void>;
}

type PromptScope = Required<Omit<CallScope, 'windowKey'>>;

const scopeOf = (context: HandlerContext): PromptScope => {
  const { projectId, threadId, promptId } = callOf(context).scope ?? {};
  if (
    projectId === undefined ||
    threadId === undefined ||
    promptId === undefined
  )
    throw new Error('executor/v1 needs a prompt scope.');
  return { projectId, threadId, promptId };
};

async function* streamOf<T>(items: readonly T[]) {
  for (const item of items) yield item;
}

/** `message` as today's JSON (`decode` with `runtimeOneofs`); `{}` when absent. */
const decodedOf = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D> | undefined,
): unknown =>
  message === undefined ? {} : decode(schema, message, runtimeOneofs);

/**
 * `client`, recording each `ReadHistory` (once answered) and `Record` (before
 * it is sent) in `traffic`; every call goes through unchanged.
 */
const traced = (
  client: Client<typeof SessionService>,
  traffic: SessionTraffic[],
): Client<typeof SessionService> => ({
  readHistory: async function* (request, options) {
    const chunks: number[] = [];
    let format: string | undefined;
    for await (const response of client.readHistory(request, options)) {
      const { item } = response;
      if (item.case === 'head') format = item.value.format;
      if (item.case === 'chunk') chunks.push(item.value.length);
      yield response;
    }
    traffic.push({
      method: 'readHistory',
      sessionId: request.sessionId ?? '',
      part: request.part ?? '',
      ...(format === undefined ? {} : { format }),
      chunks,
    });
  },
  record: async (requests, options) => {
    const items: MessageInitShape<typeof RecordRequestSchema>[] = [];
    for await (const request of requests) items.push(request);
    const head = items[0]?.item;
    traffic.push({
      method: 'record',
      sessionId: head?.case === 'head' ? (head.value.sessionId ?? '') : '',
      chunks: items.flatMap(({ item }) =>
        item?.case === 'chunk' ? [item.value.length] : [],
      ),
    });
    return await client.record(streamOf(items), options);
  },
  takeSteers: (request, options) => client.takeSteers(request, options),
  describeAttachment: (request, options) =>
    client.describeAttachment(request, options),
  watchCancel: (request, options) => client.watchCancel(request, options),
});

/**
 * The fake `[ExecutorService, impl]` and what it recorded. `session` answers
 * the client of `executor.session/v1` its callbacks go through.
 */
export const fakeExecutor = (
  options: FakeExecutorOptions,
  session: () => Client<typeof SessionService>,
) => {
  const calls: ExecutorCall[] = [];
  const traffic: SessionTraffic[] = [];
  let formats: readonly string[] = options.formats ?? [testHistoryFormat];
  /** One-shot failures, by method. */
  const failures = new Map<string, unknown[]>();

  /** `remotePromptSession` of `sessionId`, its calls recorded in `traffic`. */
  const remote = (sessionId: string): RemotePromptSession =>
    remotePromptSession(traced(session(), traffic), sessionId);

  const received = (
    method: ExecutorMethod,
    request: JsonValue,
    context: HandlerContext,
  ): ExecutorCall => {
    const call: ExecutorCall = {
      method,
      request,
      scope: callOf(context).scope,
      signal: context.signal,
    };
    calls.push(call);
    const failure = failures.get(method)?.shift();
    if (failure !== undefined) throw failure;
    return call;
  };
  /**
   * The signal a scripted `Run` or `Compact` gets: the handler's, and — with `watchCancel` — the item of the
   * `WatchCancel{sessionId}` it opens (recorded on `call`).
   */
  const signalOf = (
    call: ExecutorCall,
    sessionId: string,
    context: HandlerContext,
  ): AbortSignal => {
    if (options.watchCancel !== true) return context.signal;
    const cancelled = new AbortController();
    let items = 0;
    let done = false;
    const ended = (async () => {
      try {
        await options.watchCancelAfter?.();
        for await (const _ of session().watchCancel({ sessionId })) {
          items += 1;
          cancelled.abort();
        }
        return { ok: true } as const;
      } catch (error) {
        return { ok: false, error } as const;
      } finally {
        done = true;
      }
    })();
    call.watch = {
      cancelled: cancelled.signal,
      items: () => items,
      done: () => done,
      ended,
    };
    return AbortSignal.any([context.signal, cancelled.signal]);
  };
  const executorOf = (context: HandlerContext) =>
    scriptedExecutor(options.execute ?? (async () => 'done'), {
      formats,
      ...(options.compact === undefined ? {} : { compact: options.compact }),
    })(scopeOf(context));
  const overrides = options.overrides ?? {};

  const implementation: ServiceImpl<typeof ExecutorService> = {
    run: async (request, context) => {
      const call = received(
        'run',
        decode(RunRequestSchema, request, runtimeOneofs),
        context,
      );
      if (overrides.run !== undefined)
        return await overrides.run(request, context);
      const signal = signalOf(call, request.sessionId, context);
      const { text } = await executorOf(context).run(
        {
          thread: decodedOf(
            ExecutorThreadSchema,
            request.thread,
          ) as ExecutorThread,
          job: decodedOf(PromptJobSchema, request.job) as PromptJob,
          session: remote(request.sessionId),
        },
        { signal },
      );
      return { text };
    },
    checkpoint: async function* (request, context) {
      received('checkpoint', decode(CheckpointRequestSchema, request), context);
      if (overrides.checkpoint !== undefined) {
        yield* overrides.checkpoint(request, context);
        return;
      }
      yield* historyPatchItems(
        await executorOf(context).checkpoint({
          history: remote(request.sessionId).history,
          promptId: request.promptId,
        }),
      );
    },
    rewind: async function* (request, context) {
      received('rewind', decode(RewindRequestSchema, request), context);
      if (overrides.rewind !== undefined) {
        yield* overrides.rewind(request, context);
        return;
      }
      const patch = await executorOf(context).rewind({
        history: remote(request.sessionId).history,
        promptId: request.promptId,
        removedPromptIds: request.removedPromptIds,
      });
      for (const { item } of historyPatchItems(patch)) yield { item };
    },
    compact: async (request, context) => {
      const call = received(
        'compact',
        decode(CompactRequestSchema, request, runtimeOneofs),
        context,
      );
      if (overrides.compact !== undefined)
        return await overrides.compact(request, context);
      const signal = signalOf(call, request.sessionId, context);
      const result = await executorOf(context).compact(
        {
          thread: decodedOf(
            ExecutorThreadSchema,
            request.thread,
          ) as ExecutorThread,
          session: remote(request.sessionId),
          policy: decodedOf(
            CompactionPolicyValueSchema,
            request.policy,
          ) as CompactionPolicyValue,
        },
        { signal },
      );
      return encode(CompactResponseSchema, result);
    },
    formats: async (request, context) => {
      received('formats', {}, context);
      if (overrides.formats !== undefined)
        return await overrides.formats(request, context);
      return { formats: [...formats] };
    },
  };

  return {
    entry: [ExecutorService, implementation] as ServiceEntry,
    /** The calls received, in order. */
    calls,
    /** The `executor.session/v1` calls made back, in order. */
    traffic,
    /** The calls of `method`, in order. */
    callsOf: (method: ExecutorMethod) =>
      calls.filter((call) => call.method === method),
    /** What `Formats` answers from now on. */
    setFormats: (next: readonly string[]) => {
      formats = next;
    },
    /** The next call of `method` fails with `error` (after it is recorded). */
    failNext: (method: ExecutorMethod, error: unknown) => {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    /** The remote `PromptSession` of `sessionId`, as the fake's runs use it. */
    remote,
  };
};

export type FakeExecutor = ReturnType<typeof fakeExecutor>;
