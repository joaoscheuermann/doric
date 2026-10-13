import type { LeaseOutcome, LeaseTask } from '../../contracts/lease.js';
import type {
  BranchResult,
  CwdResult,
  DeleteResult,
  EditQueueResult,
  Page,
  Project,
  ProjectChanges,
  ProjectColor,
  ProjectDiff,
  ProjectFile,
  ProjectFileDiff,
  ProjectFiles,
  ProjectResources,
  ProjectSsh,
  ProjectTree,
  PromptAcceptResult,
  QueuedPrompt,
  RemoveQueuedResult,
  ResumeResult,
  RewindResult,
  Terminal,
  TerminalOutput,
  Thread,
  ThreadCreateResult,
  ThreadEvent,
  ThreadGitResult,
  ThreadQueue,
  ThreadUsage,
} from '../../contracts/model.js';
import type {
  ProjectActivity,
  RuntimeOwner,
  VmSsh,
} from '../../contracts/runtime.js';
import type {
  InterruptResult,
  TerminalResultInput,
} from '../../contracts/threads.js';
import type {
  ThreadTask,
  ThreadTaskOutcome,
  WithThreadOptions,
} from '../../contracts/workspace.js';

/*
 * The domain's own boundaries, moved from agents/doric's workspace types
 * (design 57 §11.1): the publisher the domain notifies after each commit and
 * the service the runtime's providers expose one method at a time.
 */

export interface WorkspacePublisher {
  terminalUpdated?(value: Terminal): void;
  terminalOutput?(value: TerminalOutput): void;
  terminalRemoved?(value: {
    readonly projectId: string;
    readonly threadId: string;
    readonly terminalId: string;
  }): void;
  event(value: ThreadEvent): void;
  threadUpdated(value: Thread): void;
  threadDeleted(projectId: string, threadId: string): void;
  projectUpdated(value: Project): void;
  projectDeleted(id: string): void;
}

export interface WorkspaceService {
  readonly projects: {
    create(name: string): Promise<Project>;
    find(id: string): Promise<Project | undefined>;
    list(limit: number, cursor?: string): Promise<Page<Project>>;
    activity(): Promise<readonly ProjectActivity[]>;
    rename(id: string, name: string): Promise<Project | undefined>;
    setColor(
      id: string,
      color: ProjectColor | undefined,
    ): Promise<Project | undefined>;
    terminate(id: string): Promise<Project | undefined>;
    delete(id: string): Promise<DeleteResult>;
    ssh(id: string): Promise<ProjectSsh>;
    files(id: string, path?: string): Promise<ProjectFiles>;
    file(id: string, path: string): Promise<ProjectFile>;
    /** The whole sandbox tree in one read; `/files` stays the single level. */
    tree(id: string, path?: string): Promise<ProjectTree>;
    diff(id: string, path?: string): Promise<ProjectDiff>;
    changes(id: string, path?: string): Promise<ProjectChanges>;
    fileDiff(
      id: string,
      repository: string,
      path: string,
    ): Promise<ProjectFileDiff>;
    resources(id: string): Promise<ProjectResources>;
    /** Runs a task on the Project's current lease, never acquiring one. */
    withLease<Value>(
      id: string,
      task: LeaseTask<Value>,
    ): Promise<LeaseOutcome<Value>>;
  };
  readonly threads: {
    queue(id: string): Promise<ThreadQueue | undefined>;
    resumeQueue(id: string): Promise<ResumeResult>;
    queuedPrompt(
      id: string,
      promptId: string,
    ): Promise<QueuedPrompt | undefined>;
    editQueued(
      id: string,
      promptId: string,
      text: string,
      revision: number,
    ): Promise<EditQueueResult>;
    removeQueued(id: string, promptId: string): Promise<RemoveQueuedResult>;
    usage(id: string): Promise<ThreadUsage | undefined>;
    /** The stored projection, without the capacity fill. */
    storedUsage(id: string): Promise<ThreadUsage | undefined>;
    /** Runs a task on one live Thread and its Project's sandbox. */
    withThread<Value>(
      id: string,
      options: WithThreadOptions,
      task: ThreadTask<Value>,
    ): Promise<ThreadTaskOutcome<Value>>;
    /** Enqueues a background terminal's result; see runtime.threads/v1. */
    terminalResult(input: TerminalResultInput): Promise<void>;
    /** Logs the failed delivery and closes the Thread. */
    failTerminalResult(id: string): Promise<void>;
    create(
      projectId: string,
      name: string,
      parentThreadId?: string,
    ): Promise<ThreadCreateResult>;
    find(id: string): Promise<Thread | undefined>;
    list(
      projectId: string,
      limit: number,
      cursor?: string,
      parentThreadId?: string,
    ): Promise<Page<Thread> | undefined>;
    rename(id: string, name: string): Promise<Thread | undefined>;
    /** Moves the Thread's working directory; see `CwdResult` for every answer. */
    setCwd(id: string, cwd: string): Promise<CwdResult>;
    /** The Git summary of the Thread's working directory, probed on demand. */
    git(id: string): Promise<ThreadGitResult>;
    branches(id: string, branch?: string, cwd?: string): Promise<BranchResult>;
    prompt(id: string, prompt: string): Promise<PromptAcceptResult>;
    /**
     * Takes up one prompt an interruption left unfinished, bringing the
     * Project's sandbox back when the host holds none, and answers the Thread.
     */
    resume(id: string, promptId: string): Promise<ResumeResult>;
    rewind(id: string, promptId: string, prompt: string): Promise<RewindResult>;
    events(
      id: string,
      afterSequence: number,
    ): Promise<
      | {
          readonly events: readonly ThreadEvent[];
          readonly lastSequence: number;
        }
      | undefined
    >;
    interrupt(id: string, promptId: string): Promise<InterruptResult>;
    terminate(id: string): Promise<Thread | undefined>;
    delete(id: string): Promise<DeleteResult>;
  };
  /**
   * Takes up every prompt the host owes a run before anyone asks: the ones its
   * own interruptions left unfinished, and the ones a crash left accepted but
   * never started. Answers how many prompts it re-enqueued.
   */
  resumeInterrupted(include?: (projectId: string) => boolean): Promise<number>;
  /** Reattach every nonterminal Project without waiting for pool capacity. */
  recoverProjects(include?: (projectId: string) => boolean): Promise<void>;
  sshForVm(id: string): Promise<VmSsh | undefined>;
  dispose(): Promise<void>;
  /** The generation handover (57-WP-H, cross-review G-1). */
  readonly handover: {
    /**
     * Before the boot recovery: records the live processes and puts the open
     * Projects one of them owns in standby. Answers which Projects the
     * recovery may touch.
     */
    begin(
      live: readonly RuntimeOwner[],
    ): Promise<(projectId: string) => boolean>;
    /**
     * Takes up the standby Projects whose owner let them go (or is not in
     * `live` any more, reconciled as after a host restart).
     */
    adopt(live: readonly RuntimeOwner[]): Promise<void>;
    /** Lets every live Project go once its running work ends. */
    drain(released: (projectId: string) => void): Promise<void>;
  };
}
