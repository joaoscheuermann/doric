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
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callGeneration,
  callOf,
  deadlineOf,
  generationOf,
} from 'bundle/contracts';
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
  /**
   * `call.signal` aborts when `runtime` cancels the run (through the session) or the `Run` call ends; the
   * implementation stops its work on it and may still use `input.session` (record what the run left) before it
   * settles. Everything else as before.
   */
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
  /**
   * The same for a compaction: `call.signal` aborts when `runtime` cancels it (through the session) or the
   * `Compact` call ends; `input.session` stays usable, so the compaction records its outcome before it settles.
   */
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
 *
 * (S51e: changes the `Run` bullet and adds one; `remotePromptSession`, `historyPatchItems` and the other handlers
 * unchanged.)
 * - `Run{sessionId, thread, job}`: after `thread` and `job` parsed (an `invalid_input` opens nothing), opens
 *   `WatchCancel{sessionId}` on `session()` — the first session call of the `Run` — and calls
 *   `run({thread, job, session}, call)` without waiting for it. `call` is the handler's call (`callOf`: same caller,
 *   scope, trace, deadline, generation) whose `signal` aborts when the handler's signal aborts or when
 *   `WatchCancel` answered its item (reason: an `AbortError` `DOMException`, as `AbortController.abort()` gives).
 *   The `WatchCancel` call is cancelled when `run` settles; a `WatchCancel` that fails, or ends with no item, is
 *   ignored (the `Run` then goes on until it ends or is cancelled). `session`'s calls — the `RemotePromptSession`
 *   callbacks — never take `call.signal`: they inherit the handler's call (scope, deadline, trace, signal), which a
 *   cancellation through the session does not abort, so the run can still read and record after it was cancelled.
 * - A `run` that rejects after `WatchCancel` answered, with anything — a `ContractError` included (such as the
 *   routed model call's `internal` "This operation was aborted") — fails the `Run` with
 *   `ContractError('run_cancelled', 'The run was cancelled.')`. A rejection before the item passes unchanged.
 *   A `run` that resolves after the cancel answers `{text}`.
 * - `Compact{sessionId, thread, policy}`: the same as `Run` — after `thread` and `policy` parsed it opens
 *   `WatchCancel{sessionId}` first, gives `compact` the derived `call` (its signal aborts on the item), cancels the
 *   stream when `compact` settles; session calls keep the handler's live signal, so the compaction's last `Record`
 *   (`compaction.failed`/`compaction.finished`) is sent after a cancel. A `compact` that rejects after the item with
 *   anything, a `ContractError` included, fails `ContractError('compaction_cancelled', 'The compaction was
 *   cancelled.')`; a rejection before the item passes unchanged; a resolved result is answered `encode`d as usual.
 * - `Checkpoint`, `Rewind`, `Formats`: no `WatchCancel`; their `call` is `callOf(context)` as before.
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

  /**
   * `work(call)` with `call` the handler's call whose signal also aborts on `WatchCancel{sessionId}`'s item; the
   * stream is opened first and cancelled once `work` settled. Any rejection after the item, a
   * `ContractError` included, becomes `cancelled()`; one before it passes unchanged.
   */
  const watchingCancel = async <T>(
    sessionId: string,
    context: HandlerContext,
    cancelled: () => ContractError,
    work: (call: Call) => Promise<T>,
  ): Promise<T> => {
    const handlerCall = callOf(context);
    const cancel = new AbortController();
    const watch = new AbortController();
    /** Whether `WatchCancel` answered its item. */
    let watched = false;
    const items = session().watchCancel(
      { sessionId },
      { signal: watch.signal },
    );
    const watching = (async () => {
      try {
        // Read to the end: the stream answers one item, then ends.
        for await (const _item of items) {
          watched = true;
          cancel.abort();
        }
      } catch {
        // A `WatchCancel` that fails is ignored: the work goes on until it ends.
      }
    })();
    // One turn so the `WatchCancel` request is sent before the work's first session call (such as `TakeSteers`),
    // and reaches the session first. Nothing firmer exists: the stream answers nothing until the cancel, and
    // waiting for its response headers hangs (B12).
    await new Promise((resolve) => setImmediate(resolve));
    // Follows the handler's signal only while `work` runs: the handler's aborts once the call ended.
    const followHandler = () => cancel.abort(handlerCall.signal.reason);
    if (handlerCall.signal.aborted) followHandler();
    else
      handlerCall.signal.addEventListener('abort', followHandler, {
        once: true,
      });
    try {
      return await work(withSignal(handlerCall, cancel.signal));
    } catch (error) {
      if (watched) throw cancelled();
      throw error;
    } finally {
      handlerCall.signal.removeEventListener('abort', followHandler);
      watch.abort();
      await watching;
    }
  };

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
      const { text } = await watchingCancel(
        request.sessionId,
        context,
        () => new ContractError('run_cancelled', 'The run was cancelled.'),
        (call) =>
          implementation.run(
            { thread, job, session: remote(request.sessionId) },
            call,
          ),
      );

      return { text };
    },
    compact: async (request, context) => {
      const { thread, policy } = executorMethods.compact.input.shape;
      const input = {
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
      };
      const result = await watchingCancel(
        request.sessionId,
        context,
        () =>
          new ContractError(
            'compaction_cancelled',
            'The compaction was cancelled.',
          ),
        (call) => implementation.compact(input, call),
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

/** The brand and deadline keys of a `Call` (`bundle/contracts/call.ts`'s registered symbols). */
const callBrand = Symbol.for('doric.call');
const callDeadline = Symbol.for('doric.call.deadline');

/**
 * A frozen copy of `call` with `signal` replaced, branded as `createHopCall` brands a call, so `isCall` holds and
 * `deadlineOf`/`generationOf` answer as for `call`.
 */
const withSignal = (call: Call, signal: AbortSignal): Call => {
  const copy: Call = { ...call, signal };
  Object.defineProperty(copy, callBrand, { value: true });
  Object.defineProperty(copy, callDeadline, { value: deadlineOf(call) });
  Object.defineProperty(copy, callGeneration, { value: generationOf(call) });
  return Object.freeze(copy);
};
