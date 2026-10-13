// Public contract of the `usage` bundle (stage 10, §3.11): a Thread's usage
// projection with its context capacity filled from the live model catalog,
// the read behind `GET /threads/:id/usage` and the footer's usage summary.

import { type CallArg, ref } from 'bundle/contracts';
import { compactResultSchema, threadUsageSchema } from 'runtime/contracts';
import { z } from 'zod';

export type {
  CompactResult,
  ContextUsage,
  ThreadUsage,
  UsageTotals,
} from 'runtime/contracts';

import type { CompactResult, ThreadUsage } from 'runtime/contracts';

/** `usage/v1` (host). */
export interface Usage {
  /** `GET /threads/:id/usage`. `undefined` is `thread_not_found`. */
  thread(threadId: string, call?: CallArg): Promise<ThreadUsage | undefined>;
  /**
   * On-demand context compaction of one idle Thread; the Thread log carries
   * the attempt either way. A `busy` Thread answers without recording.
   */
  compact(threadId: string, call?: CallArg): Promise<CompactResult>;
  /** The context fraction at which the executor condenses, in percent. */
  compactionTarget(
    call?: CallArg,
  ): Promise<{ readonly pressurePercent: number }>;
  /**
   * Moves that fraction (50–95): the executor reads it from the
   * configuration in force, so the next run condenses at the new line.
   */
  setCompactionTarget(
    input: { readonly pressurePercent: number },
    call?: CallArg,
  ): Promise<{ readonly pressurePercent: number }>;
}

export const usageMethods = {
  thread: { input: z.string(), output: threadUsageSchema.optional() },
  compact: { input: z.string(), output: compactResultSchema },
  compactionTarget: {
    input: z.tuple([]),
    output: z.looseObject({ pressurePercent: z.number() }),
  },
  setCompactionTarget: {
    input: z.object({ pressurePercent: z.number() }).strict(),
    output: z.looseObject({ pressurePercent: z.number() }),
  },
} as const;

export const UsageV1 = ref<Usage>('usage/v1');
