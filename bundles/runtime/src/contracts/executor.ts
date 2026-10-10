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
}

export interface ExecutorRunInput {
  readonly thread: Thread;
  readonly job: PromptJob;
  readonly session: PromptSession;
}

export interface ExecutorRunResult {
  readonly text: string;
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
} as const;

export const ExecutorV1 = ref<Executor>('executor/v1');
