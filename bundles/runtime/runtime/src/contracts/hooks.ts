import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

import { inputSourceSchema } from './model.js';

const cwdRepo = z.enum(['git', 'github']).optional();

/*
 * runtime.hooks/v1 (design 57 §2.11): observe hooks fired without waiting,
 * after a Project's `ready` commit and after its `cancelling` commit. No
 * default handler exists, so they change no behavior. `onThreadsClosingHook`
 * (1.1.0), `onPromptStartedHook` and `onThreadCwdChangedHook` (1.2.0) are
 * awaited by the runner instead.
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
  /**
   * 1.2.0: a prompt started, with the Thread's working directory and
   * repository hint at that moment. Awaited before the executor runs it, so
   * an instruction a handler gives it is read before the first model request.
   */
  onPromptStartedHook: defineHook({
    kind: 'observe',
    input: z
      .object({
        projectId: z.string(),
        threadId: z.string(),
        promptId: z.string(),
        source: inputSourceSchema,
        cwd: z.string(),
        cwdRepo,
      })
      .strict(),
  }),
  /**
   * 1.2.0: a Thread's working directory or its repository hint changed, with
   * both values before and after and the prompt running then, if any. Awaited
   * before the change answers its caller, so an instruction a handler gives
   * the running prompt is read at its next safe point — after the tool batch
   * that moved it.
   */
  onThreadCwdChangedHook: defineHook({
    kind: 'observe',
    input: z
      .object({
        projectId: z.string(),
        threadId: z.string(),
        promptId: z.string().optional(),
        cwd: z.string(),
        cwdRepo,
        previous: z.object({ cwd: z.string(), cwdRepo }).strict(),
      })
      .strict(),
  }),
});

/** What `onPromptStartedHook` hands its handlers. */
export type PromptStarted = z.output<
  typeof RuntimeHooksV1.hooks.onPromptStartedHook.input
>;

/** What `onThreadCwdChangedHook` hands its handlers. */
export type CwdChanged = z.output<
  typeof RuntimeHooksV1.hooks.onThreadCwdChangedHook.input
>;
