// Public contracts of the `default` bundle. It provides `executor/v1`, which
// the `runtime` bundle owns (D-S6-04), and owns `default.hooks/v1`.

import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

/**
 * default.hooks/v1: `onBeforeModelRequestHook` runs before every model
 * request of a prompt, so a handler can adjust the system prompt to the state
 * the Thread is in at that turn. `call.scope` names the prompt (`projectId`,
 * `threadId`, `promptId`) and `call.signal` aborts with it.
 */
export const DefaultHooksV1 = defineHooks('default.hooks/v1', {
  onBeforeModelRequestHook: defineHook({
    kind: 'transform',
    input: z.object({ system: z.string() }).strict(),
  }),
});
