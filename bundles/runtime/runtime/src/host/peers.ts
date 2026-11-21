import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

/*
 * The core's `core.event-hooks/v1`, rebuilt from its ID with the shape this
 * bundle observes, as `terminal` rebuilds `runtime.hooks/v1`: the runtime
 * takes no package dependency on the core.
 */

/** `core.event-hooks/v1`: fired after `events/v1.append` committed a row. */
export const CoreEventHooksV1 = defineHooks('core.event-hooks/v1', {
  onEventAppendedHook: defineHook({
    kind: 'observe',
    input: z.object({ stream: z.string(), type: z.string() }).strict(),
  }),
});
