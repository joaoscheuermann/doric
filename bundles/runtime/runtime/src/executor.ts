// `runtime/executor` (phase 3, slice S51b): the executor-side helpers of
// `executor/v1` — what a bundle providing it serves and how it calls back
// through `executor.session/v1`. Node-only; not part of `runtime/contracts`,
// which client builds import.

import type {
  DescMessage,
  JsonObject,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { type Call, ContractError, callOf } from 'bundle/contracts';
import { decodeJson, encodeJson } from 'storage/rpc';
import { z } from 'zod';

import { type Attachment, attachmentSchema } from './contracts/attachments.js';
import {
  type ExecutorCompactionInput,
  type ExecutorCompactionResult,
  type ExecutorRunInput,
  type ExecutorRunResult,
  executorMethods,
  executorThreadSchema,
  type HistoryPatch,
  type HistoryReader,
  type PromptSession,
  promptJobSchema,
  type SteerInput,
} from './contracts/executor.js';
import {
  type RecordRequestSchema,
  type SessionService,
  SteerInputSchema,
} from './contracts/gen/doric/executor/session/v1/session_pb.js';
import {
  type CheckpointResponseSchema,
  CompactionPolicyValueSchema,
  CompactResponseSchema,
  type ExecutorService,
  ExecutorThreadSchema,
  PromptJobSchema,
} from './contracts/gen/doric/executor/v1/executor_pb.js';
import { inputSourceSchema } from './contracts/model.js';
import { decode, encode, runtimeOneofs } from './host/rpc/codec.js';
import { parseInput, routed } from './host/rpc/errors.js';

/**
 * A `PromptSession` whose callbacks are `executor.session/v1` calls for one session id. It has no `attachment`
 * (bytes never cross); `describeAttachment` replaces it.
 */
export interface RemotePromptSession extends PromptSession {
  /**
   * `read(part)`: `ReadHistory{sessionId, part}`; the chunks joined and decoded (`decodeJson(…, 'invalid_output')`);
   * `undefined` when no chunk arrived. `format` is `undefined` until a read answered, then the last head's format
   * (s48 D6).
   */
  readonly history: HistoryReader;
  /**
   * `Record`: `{head: {sessionId, format?}}` (`format` when `entry.history` is given), then per part `{part}` and
   * its `encodeJson` chunks, then `{event}` when given. Resolves when the stream was answered; rejects with the
   * session's failure (`unavailable` for a persistence failure, `unknown_session`, …) as `fromConnectError` reads it.
   */
  record(entry: {
    readonly history?: HistoryPatch;
    readonly event?: unknown;
  }): Promise<void>;
  /** `TakeSteers{sessionId}`, each steer decoded with `runtimeOneofs` (the `InputSource` discriminator). */
  steers(): Promise<readonly SteerInput[]>;
  /** `DescribeAttachment{sessionId, id}`: `{id, name, mediaType, size}`; `undefined` when the answer holds none. */
  describeAttachment(id: string): Promise<Attachment | undefined>;
}

/** The remote session `sessionId` over `session`. Makes no call until a callback is used. */
export const remotePromptSession = (
  session: Client<typeof SessionService>,
  sessionId: string,
): RemotePromptSession => {
  const history: { format: string | undefined } & HistoryReader = {
    format: undefined,
    read: (part) =>
      routed(async () => {
        const chunks: Uint8Array[] = [];
        let format: string | undefined;

        for await (const { item } of session.readHistory({ sessionId, part })) {
          if (item.case === 'head') format = item.value.format;
          else if (item.case === 'chunk') chunks.push(item.value);
        }

        history.format = format;

        return chunks.length === 0
          ? undefined
          : decodeJson(chunks, 'invalid_output');
      }),
  };

  return {
    history,
    record: ({ history: patch, event }) =>
      routed(async () => {
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

        for (const [part, value] of Object.entries(patch?.parts ?? {})) {
          items.push({ item: { case: 'part', value: part } });

          for (const chunk of encodeJson(value)) {
            items.push({ item: { case: 'chunk', value: chunk } });
          }
        }

        if (event !== undefined) {
          items.push({
            item: { case: 'event', value: jsonObjectOf(event) },
          });
        }

        await session.record(streamOf(items));
      }),
    steers: () =>
      routed(async () =>
        (await session.takeSteers({ sessionId })).steers.map((steer) =>
          parseOutput(
            'steer',
            steerInputSchema,
            decode(SteerInputSchema, steer, runtimeOneofs),
          ),
        ),
      ),
    describeAttachment: (id) =>
      routed(async () => {
        const { attachment } = await session.describeAttachment({
          sessionId,
          id,
        });

        return attachment === undefined
          ? undefined
          : parseOutput('attachment', attachmentSchema, {
              id: attachment.id,
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: attachment.size,
            });
      }),
  };
};

/** A steer as `TakeSteers` answers it. */
const steerInputSchema: z.ZodType<SteerInput, SteerInput> = z.object({
  prompt: z.string(),
  source: inputSourceSchema,
});

/** `value` parsed by `schema`; `invalid_output` when a session answer breaks it. */
const parseOutput = <T>(
  what: string,
  schema: z.ZodType<T, unknown>,
  value: unknown,
): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new ContractError(
      'invalid_output',
      `executor.session/v1 answered an invalid ${what}: ${parsed.error.message}`,
    );
  }

  return parsed.data;
};

/** An event as the `Struct` a `Record` carries; `invalid_input` when it is not a JSON object. */
const jsonObjectOf = (event: unknown): JsonObject => {
  const json: unknown = JSON.parse(JSON.stringify(event) ?? 'null');

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ContractError('invalid_input', 'An event is a JSON object.');
  }

  return json as JsonObject;
};

async function* streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  yield* items;
}

/**
 * The items a `Checkpoint` or `Rewind` stream answers for `patch`: `{format}`, then per part `{part}` followed by
 * its `encodeJson` chunks (each ≤ 1 MiB, ≥ 1 per part); no item for `undefined`. `historyPatchOf` (S48) reads them
 * back to an equal patch. Throws what `encodeJson` throws (a value that is not JSON).
 */
export const historyPatchItems = (
  patch: HistoryPatch | undefined,
): MessageInitShape<typeof CheckpointResponseSchema>[] =>
  patch === undefined
    ? []
    : [
        { item: { case: 'format', value: patch.format } },
        ...Object.entries(patch.parts).flatMap(
          ([part, value]): MessageInitShape<
            typeof CheckpointResponseSchema
          >[] => [
            { item: { case: 'part', value: part } },
            ...encodeJson(value).map(
              (chunk): MessageInitShape<typeof CheckpointResponseSchema> => ({
                item: { case: 'chunk', value: chunk },
              }),
            ),
          ],
        ),
      ];

/** What an executor provider implements; each method gets `callOf` of the handler call (scope, signal, caller). */
export interface ExecutorImplementation {
  run(
    input: ExecutorRunInput,
    call: Call,
  ): Promise<Pick<ExecutorRunResult, 'text'>>;
  checkpoint(
    input: { readonly history: HistoryReader; readonly promptId: string },
    call: Call,
  ): Promise<HistoryPatch>;
  rewind(
    input: {
      readonly history: HistoryReader;
      readonly promptId: string;
      readonly removedPromptIds: readonly string[];
    },
    call: Call,
  ): Promise<HistoryPatch | undefined>;
  formats(call: Call): readonly string[] | Promise<readonly string[]>;
  compact(
    input: ExecutorCompactionInput,
    call: Call,
  ): Promise<ExecutorCompactionResult>;
}

/**
 * `executor/v1` over `implementation`. Each handler builds its sessions with `remotePromptSession(session(),
 * request.sessionId)` — `session` is called only inside a handler, never before, so a provider calls
 * `executor.session/v1` only while it serves an executor call (s48 §7):
 * - `Run{sessionId, thread, job}` → `run({thread, job, session}, call)`; `thread` and `job` decoded with
 *   `runtimeOneofs` and parsed with `executorThreadSchema` / `promptJobSchema` (`invalid_input` with the issues on
 *   a mismatch, before `run`); answers `{text}`.
 * - `Compact{sessionId, thread, policy}` → `compact(...)`, answered `encode`d.
 * - `Checkpoint{sessionId, promptId}` / `Rewind{…, removedPromptIds}` → `{history: session.history, …}`, streamed
 *   as `historyPatchItems`.
 * - `Formats{}` → `{formats}`.
 * Failures: whatever the implementation throws, as the SDK answers it (a `ContractError` unchanged, anything else
 * `internal`); the provider maps its own errors first. No state; concurrent calls are independent.
 */
export const serveExecutor = (
  implementation: ExecutorImplementation,
  session: () => Client<typeof SessionService>,
): ServiceImpl<typeof ExecutorService> => {
  const remote = (sessionId: string) =>
    remotePromptSession(session(), sessionId);
  /** `message` as today's JSON (`decode` with `runtimeOneofs`); `{}` when absent. */
  const decoded = <D extends DescMessage>(
    schema: D,
    message: MessageShape<D> | undefined,
  ): unknown =>
    message === undefined ? {} : decode(schema, message, runtimeOneofs);

  return {
    run: async (request, context) => {
      const thread = parseInput(
        'run',
        executorThreadSchema,
        decoded(ExecutorThreadSchema, request.thread),
      );
      const job = parseInput(
        'run',
        promptJobSchema,
        decoded(PromptJobSchema, request.job),
      );
      const { text } = await implementation.run(
        { thread, job, session: remote(request.sessionId) },
        callOf(context),
      );

      return { text };
    },
    compact: async (request, context) => {
      const { thread, policy } = executorMethods.compact.input.shape;
      const result = await implementation.compact(
        {
          thread: parseInput(
            'compact',
            thread,
            decoded(ExecutorThreadSchema, request.thread),
          ),
          policy: parseInput(
            'compact',
            policy,
            decoded(CompactionPolicyValueSchema, request.policy),
          ),
          session: remote(request.sessionId),
        },
        callOf(context),
      );

      return encode(CompactResponseSchema, result, runtimeOneofs);
    },
    checkpoint: async function* (request, context) {
      yield* historyPatchItems(
        await implementation.checkpoint(
          {
            history: remote(request.sessionId).history,
            promptId: request.promptId,
          },
          callOf(context),
        ),
      );
    },
    rewind: async function* (request, context) {
      const patch = await implementation.rewind(
        {
          history: remote(request.sessionId).history,
          promptId: request.promptId,
          removedPromptIds: request.removedPromptIds,
        },
        callOf(context),
      );

      // `Rewind` streams the same items as `Checkpoint`.
      for (const { item } of historyPatchItems(patch)) {
        yield { item };
      }
    },
    formats: async (_request, context) => ({
      formats: [...(await implementation.formats(callOf(context)))],
    }),
  };
};
