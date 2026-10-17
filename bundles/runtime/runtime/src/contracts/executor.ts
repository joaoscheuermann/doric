import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

import {
  type InputSource,
  inputSourceSchema,
  type Thread,
  threadSchema,
} from './model.js';
import { LOCAL_KEY } from './runtime.js';

/*
 * executor/v1: one prompt run (design 57 §2.7). Local: the run receives the
 * runtime's PromptSession, through which every history and event write goes,
 * so the runtime keeps commit-before-publish, redaction, the storage-pause
 * retry and its aggregate atomic. Cardinality `one`; `direct` provides it.
 */

export interface PromptJob {
  readonly id: string;
  readonly prompt: string;
  readonly source: InputSource;
}

/** One input that steers a running prompt: its text and where it came from. */
export type SteerInput = Pick<PromptJob, 'prompt' | 'source'>;

/** Read access to the Thread's opaque, versioned executor state. */
export interface HistoryReader {
  /** The format the stored state was written in; undefined when none exists yet. */
  readonly format: string | undefined;
  /** One named part of the state; undefined when absent. */
  read(part: string): Promise<unknown>;
}

/** Parts to write; the runtime redacts and sanitizes each value. */
export interface HistoryPatch {
  readonly format: string;
  readonly parts: Readonly<Record<string, unknown>>;
}

export interface PromptSession {
  readonly history: HistoryReader;
  /**
   * Saves `history` (if given), then appends `event` (if given) to the
   * Thread's log and publishes it. On failure it throws the runtime's own
   * persistence error and remembers the retry.
   */
  record(entry: {
    readonly history?: HistoryPatch;
    readonly event?: unknown;
  }): Promise<void>;
  /**
   * Takes the inputs that arrived for this running prompt since the last call,
   * oldest first: the reader's steering, and the results of child Threads and
   * background terminals. The executor stores each one in its history, in the
   * envelope its source names, before the next model turn and records one
   * `{ type: 'agent.steered' }` event per input, in the order it took them; an
   * input it never records returns to the Thread's queue once the run ends.
   */
  steers?(): Promise<readonly SteerInput[]>;
}

export interface ExecutorRunInput {
  readonly thread: Thread;
  readonly job: PromptJob;
  readonly session: PromptSession;
}

export interface ExecutorRunResult {
  readonly text: string;
}

/** The executor's plain compaction policy, carried in the contract. */
export interface CompactionPolicyValue {
  /** How many recent messages stay out of every condensation. */
  readonly tailMinMessages: number;
  /** The summary's character budget. */
  readonly summaryMaxChars: number;
}

export type ExecutorCompactionResult =
  | {
      readonly status: 'compacted';
      readonly summaryId: string;
      readonly condensedMessages: number;
      readonly retainedMessages: number;
      /** An estimate, not a measurement. */
      readonly tokensFreed: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | {
      /** A post-bracket failure the executor already recorded as failed. */
      readonly status: 'failed';
      readonly code: 'summarizer_failed' | 'unsafe_boundary';
    };

/** The executor's `compact` input, without a prompt job. */
export interface ExecutorCompactionInput {
  readonly thread: Thread;
  readonly session: PromptSession;
  readonly policy: CompactionPolicyValue;
}

export interface Executor {
  /** One prompt. call.scope = { projectId, threadId, promptId }; call.signal aborts it. */
  run(input: ExecutorRunInput, call?: CallArg): Promise<ExecutorRunResult>;
  /** Before prompt.started: records the turn boundary once (an existing key wins). */
  checkpoint(
    input: { readonly history: HistoryReader; readonly promptId: string },
    call?: CallArg,
  ): Promise<HistoryPatch>;
  /** Rewind participation: the truncated state, or undefined without a checkpoint. */
  rewind(
    input: {
      readonly history: HistoryReader;
      readonly promptId: string;
      readonly removedPromptIds: readonly string[];
    },
    call?: CallArg,
  ): Promise<HistoryPatch | undefined>;
  /** History formats this executor reads. */
  formats(call?: CallArg): readonly string[];
  /**
   * On-demand compaction of an idle Thread: condenses the oldest safe span
   * into one summary message and records it. call.scope carries the
   * compaction's own promptId; call.signal aborts the summarization.
   */
  compact(
    input: ExecutorCompactionInput,
    call?: CallArg,
  ): Promise<ExecutorCompactionResult>;
}

const local = <T>(test: (value: unknown) => boolean, message: string) =>
  z.custom<T>(test, { message }).meta({ [LOCAL_KEY]: 'object' });

const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null;

export const historyReaderSchema = local<HistoryReader>(
  (value) =>
    isObject(value) && typeof (value as { read?: unknown }).read === 'function',
  'Expected a history reader.',
);

export const promptSessionSchema = local<PromptSession>(
  (value) =>
    isObject(value) &&
    typeof (value as { record?: unknown }).record === 'function',
  'Expected a prompt session.',
);

export const promptJobSchema: z.ZodType<PromptJob, PromptJob> = z.looseObject({
  id: z.string(),
  prompt: z.string(),
  source: inputSourceSchema,
});

export const historyPatchSchema: z.ZodType<HistoryPatch, HistoryPatch> =
  z.looseObject({
    format: z.string(),
    parts: z.record(z.string(), z.unknown()),
  });

export const executorMethods = {
  run: {
    input: z
      .object({
        thread: threadSchema,
        job: promptJobSchema,
        session: promptSessionSchema,
      })
      .strict(),
    output: z.looseObject({ text: z.string() }),
  },
  checkpoint: {
    input: z
      .object({ history: historyReaderSchema, promptId: z.string() })
      .strict(),
    output: historyPatchSchema,
  },
  rewind: {
    input: z
      .object({
        history: historyReaderSchema,
        promptId: z.string(),
        removedPromptIds: z.array(z.string()),
      })
      .strict(),
    output: historyPatchSchema.optional(),
  },
  formats: { input: z.tuple([]), output: z.array(z.string()) },
  compact: {
    input: z
      .object({
        thread: threadSchema,
        session: promptSessionSchema,
        policy: z
          .object({ tailMinMessages: z.number(), summaryMaxChars: z.number() })
          .strict(),
      })
      .strict(),
    output: z.looseObject({
      status: z.enum(['compacted', 'refused', 'failed']),
      summaryId: z.string().optional(),
      condensedMessages: z.number().optional(),
      retainedMessages: z.number().optional(),
      tokensFreed: z.number().optional(),
      reason: z
        .enum(['disabled', 'missing_history', 'nothing_to_compact'])
        .optional(),
      code: z.string().optional(),
    }),
  },
} as const;

export const ExecutorV1 = ref<Executor>('executor/v1');
