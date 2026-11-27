// usage/v1 (stage 10, §3.11): the stored projection from
// `runtime.usage/v1.read`, with a context that lacks its capacity filled
// through `models/v1.contextWindow` (moved from the runtime's
// usage-context.ts; the candidate rules live in the core). A recorded
// capacity is never replaced; no answer leaves it unknown.

/**
 * Fills a missing context capacity from the live catalog: when
 * `usage.context` exists without `contextWindow`, asks `contextWindow({model,
 * providerId?})` once. An answer that is finite, above 0 and whole sets
 * `context.contextWindow` and `contextWindowSource: 'catalog'` in a copy.
 * Otherwise `usage` is answered as given: no context, a recorded capacity, no
 * answer, an unusable one, or a rejection (never propagated). Works on
 * today's `ThreadUsage` and on the `doric.runtime.v2.ThreadUsage` message
 * alike; the copy keeps every other field (and a message's `$typeName`).
 */
export const withContextCapacity = async <
  U extends {
    readonly context?: {
      readonly model: string;
      readonly providerId?: string;
      readonly contextWindow?: number;
    };
  },
>(
  usage: U,
  contextWindow: (request: {
    readonly providerId?: string;
    readonly model: string;
  }) => Promise<number | undefined>,
): Promise<U> => {
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
  return capacity !== undefined && Number.isInteger(capacity) && capacity > 0
    ? ({
        ...usage,
        context: {
          ...context,
          contextWindow: capacity,
          contextWindowSource: 'catalog',
        },
      } as U)
    : usage;
};
