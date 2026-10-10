// usage/v1 (stage 10, §3.11): the stored projection from
// `runtime.usage/v1.read`, with a context that lacks its capacity filled
// through `models/v1.contextWindow` (moved from the runtime's
// usage-context.ts; the candidate rules live in the core). A recorded
// capacity is never replaced; no answer leaves it unknown.

import {
  type Call,
  defineMethod,
  defineService,
  ModelsV1,
} from 'bundle/contracts';
import { RuntimeUsageV1, type ThreadUsage } from 'runtime/contracts';

import { UsageV1, usageMethods } from '../contracts/index.js';

/** Fills a missing context capacity from the live catalog. */
export const withContextCapacity = async (
  usage: ThreadUsage,
  contextWindow: (request: {
    readonly providerId?: string;
    readonly model: string;
  }) => Promise<number | undefined>,
): Promise<ThreadUsage> => {
  const context = usage.context;
  if (context === undefined || context.contextWindow !== undefined)
    return usage;
  let capacity: number | undefined;
  try {
    capacity = await contextWindow(
      context.providerId === undefined
        ? { model: context.model }
        : { providerId: context.providerId, model: context.model },
    );
  } catch {
    return usage;
  }
  return capacity !== undefined && Number.isFinite(capacity) && capacity > 0
    ? {
        ...usage,
        context: {
          ...context,
          contextWindow: capacity,
          contextWindowSource: 'catalog',
        },
      }
    : usage;
};

export const usageService = defineService(UsageV1, {
  thread: defineMethod({
    ...usageMethods.thread,
    execute: async (threadId: string, call: Call, services) => {
      const usage = await services.use(RuntimeUsageV1).read(threadId, call);
      if (usage === undefined) return undefined;
      const models = services.use(ModelsV1);
      return withContextCapacity(usage, (request) =>
        models.contextWindow(request, call),
      );
    },
  }),
});
