import {
  bindRegistrant,
  type Call,
  type ContractTool,
  type Registrable,
  type Services,
} from 'bundle/contracts';
import {
  type LeaseOutcome,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  type ThreadTaskOutcome,
  type WithThreadOptions,
} from 'runtime/contracts';
import type { TerminalSession } from 'terminal/contracts';
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import {
  currentDirectory,
  type GitSandbox,
  type LeaseSandbox,
  leaseSandbox,
} from './sandbox.js';
import type { TerminalList } from './service.js';

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

/**
 * The tool ports over the kernel `Services`: `cwd` is `currentDirectory`,
 * `sandbox` is `leaseSandbox`. Today's behaviour. Kernel-only; deleted in
 * group F.
 */
export const kernelGitToolPorts = (services: Services): GitToolPorts => ({
  cwd: (call) => currentDirectory(services, call),
  sandbox: (call) => leaseSandbox(services, call),
});

/**
 * A kernel `Registrable` of `definition`, binding
 * `kernelGitToolPorts(services)` when the kernel's `tools/v1` binds it.
 * Kernel-only; deleted in group F.
 */
export const kernelRegistrable = (
  definition: UnboundTool<ToolInput, ToolOutput, GitToolPorts>,
): Registrable<ContractTool> => ({
  [bindRegistrant]: (services) => definition.bind(kernelGitToolPorts(services)),
});

/**
 * The command ports over the kernel `Services` for one call (S55c):
 * - `withThread` → `RuntimeWorkspaceV1.withThread(threadId, options, task',
 *   call)` under `call.scope`, where `task'` passes the `ThreadContext` with
 *   `busyCwds` made async;
 * - `withProjectLease` → `RuntimeLeaseV1.withLease(task, call)` under
 *   `call.scope`;
 * - `terminals(projectId)` → `terminals()?.list(projectId, call) ?? []`.
 * Today's behaviour. Kernel-only; deleted in group F.
 */
export const kernelGitCommandPorts = (
  services: Services,
  call: Call,
  terminals: TerminalList,
): GitCommandPorts => ({
  withThread: (threadId, options, task) =>
    services.use(RuntimeWorkspaceV1, call.scope).withThread(
      threadId,
      options,
      (thread) =>
        task({
          projectId: thread.projectId,
          threadId: thread.threadId,
          cwd: thread.cwd,
          sandbox: thread.sandbox,
          busyCwds: async () => thread.busyCwds(),
        }),
      call,
    ),
  withProjectLease: (task) =>
    services.use(RuntimeLeaseV1, call.scope).withLease(task, call),
  terminals: async (projectId) =>
    (await terminals()?.list(projectId, call)) ?? [],
});
