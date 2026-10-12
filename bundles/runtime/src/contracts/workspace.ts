import { type CallArg, functionSchema, ref } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';
import { z } from 'zod';

import { LOCAL_KEY } from './runtime.js';

/*
 * runtime.workspace/v1: the working directory of the calling prompt's own
 * Thread (call.scope), derived from the tool-host WorkspaceControl.
 */

/** What moving a Thread's working directory did; every outcome is a value. */
export type CwdChange =
  | { readonly status: 'set'; readonly cwd: string }
  /** The resolved path leaves the workspace root. */
  | { readonly status: 'outside' }
  /** No such path. */
  | { readonly status: 'missing' }
  /** The path exists and is not a directory. */
  | { readonly status: 'not-directory' };

export const cwdChangeSchema: z.ZodType<CwdChange, CwdChange> = z.union([
  z.looseObject({ status: z.literal('set'), cwd: z.string() }),
  z.looseObject({ status: z.enum(['outside', 'missing', 'not-directory']) }),
]);

/** What `withThread` hands its task: the live Thread and its Project's sandbox. */
export interface ThreadContext {
  readonly projectId: string;
  readonly threadId: string;
  /** The Thread's working directory when the task started. */
  readonly cwd: string;
  readonly sandbox: Sandbox;
  /** Whether the Project or the Thread started closing. */
  closing(): boolean;
  /** The cwds of the Project's Threads with an active or queued prompt. */
  busyCwds(): readonly string[];
}

export interface WithThreadOptions {
  /** Runs the task under the Project mutation lock. */
  readonly exclusive: boolean;
  /** Brings the Project back from durable state first. */
  readonly resume?: boolean;
  /** Refreshes the Thread's repository hint after the task. */
  readonly refreshHint?: boolean;
}

export type ThreadTaskOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  /** `missing`: no record. `inactive`: no runtime, closing or terminal. `pending`: no lease. */
  | { readonly status: 'missing' | 'inactive' | 'pending' };

export type ThreadTask<T> = (thread: ThreadContext) => Promise<T>;

export interface RuntimeWorkspace {
  /** The Thread's current working directory, absolute inside the sandbox. */
  cwd(call?: CallArg): Promise<string>;
  /**
   * Moves the Thread's working directory. A relative path resolves against
   * the current directory, the way `cd` does; outside the workspace root
   * nothing moves.
   */
  setCwd(path: string, call?: CallArg): Promise<CwdChange>;
  /**
   * 1.1.0, local only: runs `task` on one live Thread, whatever the call's
   * scope. The outcome is a value; the task's own rejection propagates.
   */
  withThread<T>(
    threadId: string,
    options: WithThreadOptions,
    task: ThreadTask<T>,
    call?: CallArg,
  ): Promise<ThreadTaskOutcome<T>>;
}

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export const threadTaskOutcomeSchema = z
  .custom<ThreadTaskOutcome<unknown>>(
    (value) =>
      isObject(value) &&
      ['ready', 'missing', 'inactive', 'pending'].includes(
        (value as { status?: unknown }).status as string,
      ),
    { message: 'Expected a Thread outcome.' },
  )
  .meta({ [LOCAL_KEY]: 'object' });

export const withThreadOptionsSchema = z
  .object({
    exclusive: z.boolean(),
    resume: z.boolean().optional(),
    refreshHint: z.boolean().optional(),
  })
  .strict();

export const threadTaskSchema = functionSchema<ThreadTask<unknown>>().meta({
  [LOCAL_KEY]: 'callback',
});

export const runtimeWorkspaceMethods = {
  cwd: { input: z.tuple([]), output: z.string() },
  setCwd: { input: z.string(), output: cwdChangeSchema },
  withThread: {
    input: z.tuple([z.string(), withThreadOptionsSchema, threadTaskSchema]),
    output: threadTaskOutcomeSchema,
  },
} as const;

export const RuntimeWorkspaceV1 = ref<RuntimeWorkspace>('runtime.workspace/v1');
