// The runtime contracts this bundle calls, built from their IDs with local
// shapes (the way `layout` and `notifications` reach their peers): the
// runtime itself imports `terminal/contracts`, so importing
// `runtime/contracts` here would close a cycle between the two projects.
// Each shape is the runtime's own, narrowed to what this bundle calls.

import { type CallArg, defineHook, defineHooks, ref } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';
import { z } from 'zod';

/** What `runtime.workspace/v1.withThread` hands its task. */
export interface ThreadContext {
  readonly projectId: string;
  readonly threadId: string;
  /** The Thread's working directory when the task started. */
  readonly cwd: string;
  readonly sandbox: Sandbox;
  /** Whether the Project or the Thread started closing. */
  closing(): boolean;
  busyCwds(): readonly string[];
}

export type ThreadTaskOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'missing' | 'inactive' | 'pending' };

/** `runtime.workspace/v1` (1.1.0), for `cwd` and `withThread` only. */
export interface RuntimeWorkspace {
  /** The calling prompt's Thread's working directory. */
  cwd(call?: CallArg): Promise<string>;
  withThread<T>(
    threadId: string,
    options: {
      readonly exclusive: boolean;
      readonly resume?: boolean;
      readonly refreshHint?: boolean;
    },
    task: (thread: ThreadContext) => Promise<T>,
    call?: CallArg,
  ): Promise<ThreadTaskOutcome<T>>;
}

export const RuntimeWorkspaceV1 = ref<RuntimeWorkspace>('runtime.workspace/v1');

/** `runtime.threads/v1` (1.2.0), for the background terminal results only. */
export interface RuntimeThreads {
  enqueueTerminalResult(
    input: {
      readonly threadId: string;
      readonly promptId: string;
      readonly terminalId: string;
      readonly text: string;
    },
    call?: CallArg,
  ): Promise<void>;
  failTerminalResult(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<void>;
}

export const RuntimeThreadsV1 = ref<RuntimeThreads>('runtime.threads/v1');

/** `runtime.hooks/v1` (1.1.0), for `onThreadsClosingHook` only. */
export const RuntimeHooksV1 = defineHooks('runtime.hooks/v1', {
  onThreadsClosingHook: defineHook({
    kind: 'observe',
    input: z
      .object({ projectId: z.string(), threadIds: z.array(z.string()) })
      .strict(),
  }),
});
