import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

/*
 * runtime.hooks/v1 (design 57 §2.11): observe hooks fired without waiting,
 * after a Project's `ready` commit and after its `cancelling` commit. No
 * default handler exists, so they change no behavior. `onThreadsClosingHook`
 * (1.1.0) is awaited by the runner instead.
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
  /**
   * 1.1.0: some of a Project's Threads are closing (termination, host stop,
   * drain). Executed and awaited where the runner closes their terminals,
   * before it awaits their running work.
   */
  onThreadsClosingHook: defineHook({
    kind: 'observe',
    input: z
      .object({ projectId: z.string(), threadIds: z.array(z.string()) })
      .strict(),
  }),
});
