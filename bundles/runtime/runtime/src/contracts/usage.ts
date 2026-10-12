import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

import { type ThreadUsage, threadUsageSchema } from './model.js';

/*
 * runtime.usage/v1 (stage 10 R-5.5): a Thread's stored usage projection as
 * the store answers it, without the context capacity fill that
 * runtime.threads/v1.usage adds. The `usage` bundle fills it through
 * models/v1.contextWindow.
 */

export interface RuntimeUsage {
  /** `undefined` when the Thread does not exist. */
  read(threadId: string, call?: CallArg): Promise<ThreadUsage | undefined>;
}

export const runtimeUsageMethods = {
  read: { input: z.string(), output: threadUsageSchema.optional() },
} as const;

export const RuntimeUsageV1 = ref<RuntimeUsage>('runtime.usage/v1');
