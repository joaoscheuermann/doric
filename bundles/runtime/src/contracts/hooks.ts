import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

/*
 * runtime.hooks/v1 (design 57 §2.11): observe hooks fired without waiting,
 * after a Project's `ready` commit and after its `cancelling` commit. No
 * default handler exists, so they change no behavior.
 */
export const RuntimeHooksV1 = defineHooks('runtime.hooks/v1', {
  onProjectReadyHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
  onProjectClosingHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
});
