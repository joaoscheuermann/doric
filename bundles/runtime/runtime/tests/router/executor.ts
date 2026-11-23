// The fake `executor/v1` provider of runtime's router tests (phase 3, slice
// S48b, contract §5 "Harness"). It serves `ExecutorService` over the domain
// tests' `scriptedExecutor` (`../support/executor.ts`): each request becomes
// the domain input, whose `PromptSession` calls back through
// `executor.session/v1` as the executor's provider would (caller
// `executorCaller`). A `HistoryPatch` answer travels as `format`/`part`/
// `chunk` items. It records every call it receives and every session call
// it makes.

import type {
  DescMessage,
  JsonObject,
  JsonValue,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { type Caller, type CallScope, callOf } from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';
import { decodeJson, encodeJson } from 'storage/rpc';

import type { AttachmentContent } from '../../src/contracts/attachments.js';
import type {
  CompactionPolicyValue,
  Executor,
  ExecutorThread,
  HistoryPatch,
  HistoryReader,
  PromptJob,
  PromptSession,
  SteerInput,
} from '../../src/contracts/executor.js';
import {
  type RecordRequestSchema,
  type SessionService,
  SteerInputSchema,
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

/** One `Checkpoint` or `Rewind` item. */
interface PatchItem {
  readonly item:
    | { readonly case: 'format' | 'part'; readonly value: string }
    | { readonly case: 'chunk'; readonly value: Uint8Array };
}

/** A `HistoryPatch` as the items `Checkpoint` and `Rewind` stream. */
export const patchItems = (patch: HistoryPatch | undefined): PatchItem[] =>
  patch === undefined
    ? []
    : [
        { item: { case: 'format', value: patch.format } },
        ...Object.entries(patch.parts).flatMap(([part, value]): PatchItem[] => [
          { item: { case: 'part', value: part } },
          ...encodeJson(value).map(
            (chunk): PatchItem => ({ item: { case: 'chunk', value: chunk } }),
          ),
        ]),
      ];

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

  /** The `PromptSession` of `sessionId`, every callback through `executor.session/v1`. */
  const remote = (sessionId: string): PromptSession => {
    const history: { format: string | undefined } & HistoryReader = {
      format: undefined,
      read: async (part) => {
        const chunks: Uint8Array[] = [];
        let format: string | undefined;
        for await (const { item } of session().readHistory({
          sessionId,
          part,
        })) {
          if (item.case === 'head') format = item.value.format;
          if (item.case === 'chunk') chunks.push(item.value);
        }
        history.format = format;
        traffic.push({
          method: 'readHistory',
          sessionId,
          part,
          ...(format === undefined ? {} : { format }),
          chunks: chunks.map(({ length }) => length),
        });
        return chunks.length === 0
          ? undefined
          : decodeJson(chunks, 'invalid_output');
      },
    };
    return {
      history,
      record: async ({ history: patch, event }) => {
        type Item = MessageInitShape<typeof RecordRequestSchema>;
        const items: Item[] = [
          {
            item: {
              case: 'head',
              value: {
                sessionId,
                ...(patch === undefined ? {} : { format: patch.format }),
              },
            },
          },
        ];
        const sizes: number[] = [];
        for (const [part, value] of Object.entries(patch?.parts ?? {})) {
          items.push({ item: { case: 'part', value: part } });
          for (const chunk of encodeJson(value)) {
            sizes.push(chunk.length);
            items.push({ item: { case: 'chunk', value: chunk } });
          }
        }
        if (event !== undefined)
          items.push({
            item: {
              case: 'event',
              value: event as JsonObject,
            },
          });
        traffic.push({ method: 'record', sessionId, chunks: sizes });
        await session().record(streamOf(items));
      },
      steers: async () =>
        (await session().takeSteers({ sessionId })).steers.map(
          (steer) =>
            decode(
              SteerInputSchema,
              steer,
              runtimeOneofs,
            ) as unknown as SteerInput,
        ),
      attachment: async (id) => {
        const { attachment } = await session().describeAttachment({
          sessionId,
          id,
        });
        return attachment === undefined
          ? undefined
          : ({
              id: attachment.id,
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: attachment.size,
              bytes: new Uint8Array(),
            } as unknown as AttachmentContent);
      },
    };
  };

  const received = (
    method: ExecutorMethod,
    request: JsonValue,
    context: HandlerContext,
  ) => {
    calls.push({
      method,
      request,
      scope: callOf(context).scope,
      signal: context.signal,
    });
    const failure = failures.get(method)?.shift();
    if (failure !== undefined) throw failure;
  };
  const executorOf = (context: HandlerContext) =>
    scriptedExecutor(options.execute ?? (async () => 'done'), {
      formats,
      ...(options.compact === undefined ? {} : { compact: options.compact }),
    })(scopeOf(context));
  const overrides = options.overrides ?? {};

  const implementation: ServiceImpl<typeof ExecutorService> = {
    run: async (request, context) => {
      received(
        'run',
        decode(RunRequestSchema, request, runtimeOneofs),
        context,
      );
      if (overrides.run !== undefined)
        return await overrides.run(request, context);
      const { text } = await executorOf(context).run(
        {
          thread: decodedOf(
            ExecutorThreadSchema,
            request.thread,
          ) as ExecutorThread,
          job: decodedOf(PromptJobSchema, request.job) as PromptJob,
          session: remote(request.sessionId),
        },
        { signal: context.signal },
      );
      return { text };
    },
    checkpoint: async function* (request, context) {
      received('checkpoint', decode(CheckpointRequestSchema, request), context);
      if (overrides.checkpoint !== undefined) {
        yield* overrides.checkpoint(request, context);
        return;
      }
      yield* patchItems(
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
      yield* patchItems(
        await executorOf(context).rewind({
          history: remote(request.sessionId).history,
          promptId: request.promptId,
          removedPromptIds: request.removedPromptIds,
        }),
      );
    },
    compact: async (request, context) => {
      received(
        'compact',
        decode(CompactRequestSchema, request, runtimeOneofs),
        context,
      );
      if (overrides.compact !== undefined)
        return await overrides.compact(request, context);
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
        { signal: context.signal },
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
