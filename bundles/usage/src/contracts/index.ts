// Public contract of the `usage` bundle (stage 10, §3.11): a Thread's usage
// projection with its context capacity filled from the live model catalog,
// the read behind `GET /threads/:id/usage` and the footer's usage summary.

import { type CallArg, ref } from 'bundle/contracts';
import { threadUsageSchema } from 'runtime/contracts';
import { z } from 'zod';

export type {
  ContextUsage,
  ThreadUsage,
  UsageTotals,
} from 'runtime/contracts';

import type { ThreadUsage } from 'runtime/contracts';

/** `usage/v1` (host). */
export interface Usage {
  /** `GET /threads/:id/usage`. `undefined` is `thread_not_found`. */
  thread(threadId: string, call?: CallArg): Promise<ThreadUsage | undefined>;
}

export const usageMethods = {
  thread: { input: z.string(), output: threadUsageSchema.optional() },
} as const;

export const UsageV1 = ref<Usage>('usage/v1');
