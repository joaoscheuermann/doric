import type { Call } from 'bundle/contracts';
import type {
  LeaseOutcome,
  ThreadTaskOutcome,
  WithThreadOptions,
} from 'runtime/contracts';
import type { TerminalSession } from 'terminal/contracts';

import type { GitSandbox, LeaseSandbox } from './sandbox.js';

/** What the `git` tool reaches, per call; each method runs under `call`. */
export interface GitToolPorts {
  /** The working directory of the prompt's Thread, absolute in the sandbox. */
  cwd(call: Call): Promise<string>;
  /**
   * The prompt's sandbox: its `id`, `root` and `exec` on that same sandbox.
   * An `exec` after the sandbox changed rejects `unavailable` (detail
   * `leaseStatus: 'unavailable'`) and runs nothing. Rejects with the
   * provider's `ContractError` (code, message, details kept).
   */
  sandbox(call: Call): Promise<Pick<LeaseSandbox, 'id' | 'root' | 'exec'>>;
}

/** One live Thread as a `git.commands/v1` task sees it (today's `ThreadContext`, narrowed). */
export interface GitThread {
  readonly projectId: string;
  readonly threadId: string;
  /** The Thread's working directory when the task started. */
  readonly cwd: string;
  /** The Thread's sandbox; every step runs on it while the task runs. */
  readonly sandbox: GitSandbox;
  /**
   * The working directories of the Project's Threads with an active or
   * queued prompt, read now. Rejects with the provider's failure.
   */
  busyCwds(): Promise<readonly string[]>;
}

/** What the busy check reads of one tracked terminal. */
export type TerminalListing = Pick<
  TerminalSession,
  'state' | 'origin' | 'command' | 'cwd'
>;

/** What `git.commands/v1`'s bodies reach, for one call. */
export interface GitCommandPorts {
  /**
   * Runs `task` on the live Thread `threadId`, holding it live and, with
   * `exclusive`, the Project mutation lock until `task` settles. With
   * `refreshHint`, the Thread's repository hint is refreshed after it.
   * Answers `{status: 'ready', value}`, or `missing` / `inactive` /
   * `pending` without running `task` (`''` is `missing`). Rejects with
   * `task`'s rejection or the provider's failure (`unknown_session` when the
   * session ended under the task).
   */
  withThread<T>(
    threadId: string,
    options: WithThreadOptions,
    task: (thread: GitThread) => Promise<T>,
  ): Promise<ThreadTaskOutcome<T>>;
  /**
   * Runs `task` on the current sandbox of the call's Project, never
   * acquiring one. Answers `{status: 'ready', value}`, or the lease's
   * `pending` / `unavailable` / `expired` / `missing` when the lease is not
   * ready or is lost between steps. Rejects `invalid_input`
   * (`leaseScopeMessage`) when the call's scope has no `projectId`, and with
   * any other failure of a step.
   */
  withProjectLease<T>(
    task: (sandbox: GitSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>>;
  /**
   * The Project's tracked terminals, while some bundle provides
   * `terminal/v1`; `[]` when none does. Rejects with any other failure.
   */
  terminals(projectId: string): Promise<readonly TerminalListing[]>;
}
