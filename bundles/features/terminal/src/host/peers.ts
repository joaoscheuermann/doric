// The runtime contracts this bundle's host part calls, built from their IDs
// with local shapes (the way `layout` and `notifications` reach their peers).
// They were copies because the runtime imported `terminal/contracts`; it no
// longer does (bundle isolation 7(c)), and the client part imports the
// runtime's contracts, but the host part keeps these. Each shape is the
// runtime's own, narrowed to what this bundle calls.

import type { CallArg } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

/**
 * What a terminal task uses of a live Thread: a routed Thread session.
 * `sandbox.start` starts a live process on the Thread's sandbox; `closing()`
 * answers whether the Project or the Thread started closing, read when called.
 */
export interface TerminalThread {
  readonly projectId: string;
  readonly threadId: string;
  /** The Thread's working directory when the task started. */
  readonly cwd: string;
  readonly sandbox: Pick<Sandbox, 'start'>;
  closing(): boolean | PromiseLike<boolean>;
}

export type ThreadTaskOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'missing' | 'inactive' | 'pending' };

/** `runtime.workspace/v1` (1.1.0), for `cwd` and `withThread` only. */
export interface RuntimeWorkspace {
  /** The calling prompt's Thread's working directory. */
  cwd(call?: CallArg): Promise<string>;
  /**
   * Runs `task` on one live Thread while it is held (with `exclusive`, under
   * the Project mutation lock), after bringing its Project back with
   * `resume`. The hold ends when the task settles; a process it started keeps
   * running. Answers the task's value, or why no Thread was held. Rejects
   * with the task's rejection or the provider's error.
   */
  withThread<T>(
    threadId: string,
    options: {
      readonly exclusive: boolean;
      readonly resume?: boolean;
      readonly refreshHint?: boolean;
    },
    task: (thread: TerminalThread) => Promise<T>,
    call?: CallArg,
  ): Promise<ThreadTaskOutcome<T>>;
}

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
