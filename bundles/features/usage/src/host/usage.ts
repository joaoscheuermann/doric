// usage/v1 (stage 10, §3.11): the stored projection from
// `runtime.usage/v1.read`, with a context that lacks its capacity filled
// through `models/v1.contextWindow` (moved from the runtime's
// usage-context.ts; the candidate rules live in the core). A recorded
// capacity is never replaced; no answer leaves it unknown. The compaction
// members ride the same service: the footer's compact button, and the
// pressure line it shows and moves.

import {
  type Call,
  defineMethod,
  defineService,
  ModelsV1,
} from 'bundle/contracts';
import {
  ConfigurationV1,
  defaultContextCompaction,
} from 'host-config/contracts';
import {
  RuntimeThreadsV1,
  RuntimeUsageV1,
  type ThreadUsage,
} from 'runtime/contracts';
import type { z } from 'zod';

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

/**
 * The pressure line the configuration in force names; an absent section is
 * the default one, so the popover never shows a blank slider.
 */
export const compactionTargetOf = async (
  call: Call,
  configuration: {
    current(call?: Call): Promise<{
      readonly configuration: {
        readonly execution: {
          readonly contextCompaction?: { readonly pressurePercent: number };
        };
      };
    }>;
  },
): Promise<{ readonly pressurePercent: number }> => {
  const { configuration: value } = await configuration.current(call);
  return {
    pressurePercent:
      value.execution.contextCompaction?.pressurePercent ??
      defaultContextCompaction.pressurePercent,
  };
};

export const usageService = defineService(UsageV1, {
  thread: defineMethod({
    expose: 'desktop',
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
  compact: defineMethod({
    expose: 'desktop',
    ...usageMethods.compact,
    execute: (threadId: string, call: Call, services) =>
      services.use(RuntimeThreadsV1).compact({ id: threadId }, call),
  }),
  compactionTarget: defineMethod({
    expose: 'desktop',
    ...usageMethods.compactionTarget,
    execute: async (
      _input: readonly [],
      call: Call,
      services,
    ): Promise<z.infer<typeof usageMethods.compactionTarget.output>> => ({
      ...(await compactionTargetOf(call, services.use(ConfigurationV1))),
    }),
  }),
  setCompactionTarget: defineMethod({
    expose: 'desktop',
    ...usageMethods.setCompactionTarget,
    execute: async (
      input: { readonly pressurePercent: number },
      call: Call,
      services,
    ) => {
      const configuration = services.use(ConfigurationV1);
      const { configuration: value } = await configuration.current(call);
      const section =
        value.execution.contextCompaction ?? defaultContextCompaction;
      const replaced = await configuration.replace(
        {
          ...value,
          execution: {
            ...value.execution,
            contextCompaction: {
              ...section,
              pressurePercent: input.pressurePercent,
            },
          },
        },
        call,
      );
      // A refused replace keeps the line the configuration still names; the
      // client reads the validated answer either way.
      return {
        pressurePercent:
          replaced.status === 'replaced'
            ? input.pressurePercent
            : section.pressurePercent,
      };
    },
  }),
});
