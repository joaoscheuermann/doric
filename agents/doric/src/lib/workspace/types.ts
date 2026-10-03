import type { CwdChange } from 'host';
import type { ProviderMessage } from 'llms';
import type { SandboxEntry, SandboxSshAccess, SandboxTreeNode } from 'sandbox';

import type { DoricConfig } from '../config/schema.js';
import type { ProjectColor } from './colors.js';
import type { ProjectChangeSet } from './files.js';

export type ProjectState =
  | 'queued'
  | 'ready'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
export type ThreadState = ProjectState | 'running';
export type Project = {
  readonly id: string;
  readonly name: string;
  readonly color?: ProjectColor;
  readonly state: ProjectState;
  readonly configRevision: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
};
/**
 * The materialized result of a thread's most recent finished prompt. It is
 * stored on the thread so reading a child's state never reconstructs it from
 * the event log.
 */
export type ThreadOutcome = {
  readonly status: string;
  readonly text: string;
  readonly promptId: string;
  readonly at: string;
};

/**
 * What a Thread's working directory is, as far as a cheap probe can tell: `git`
 * when the directory's own root holds a `.git` marker, `github` when that
 * repository's `origin` points at github.com. It is absent when the directory's
 * own root holds no repository at all, which is the common case for a
 * subdirectory of one.
 */
export type CwdRepo = 'git' | 'github';

/**
 * The one thing a repository can be part-way through. Only one is reported, even
 * when Git leaves the markers of two behind, in the order a reader would expect:
 * a rebase's own marker first, then a cherry-pick's, a revert's, a merge's and a
 * bisect's.
 */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

/**
 * The Git summary of one Thread's working directory, read by
 * `GET /threads/:id/git`. `repo: false` is a complete answer: a directory that
 * holds, or lies in, no repository is not a failure, it is simply not a
 * repository.
 */
export type ThreadGit =
  | { readonly repo: false }
  | {
      readonly repo: true;
      /** The repository root the working directory lies in, sandbox-absolute. */
      readonly root: string;
      /** The branch name, or the short commit when HEAD is detached. */
      readonly head: string;
      readonly detached: boolean;
      /** A repository that has no commit yet. */
      readonly unborn: boolean;
      readonly upstream: string | null;
      readonly ahead: number;
      readonly behind: number;
      readonly dirty: {
        readonly staged: number;
        readonly modified: number;
        readonly untracked: number;
      };
      readonly conflicted: number;
      readonly operation: GitOperation | null;
      /** Whether the working directory is a linked worktree of another clone. */
      readonly worktree: boolean;
      readonly shallow: boolean;
      readonly stash: number;
      /** How many submodules the repository declares, at any depth. */
      readonly submodules: number;
    };

export type Thread = {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly name: string;
  readonly state: ThreadState;
  readonly lastSequence: number;
  /** The working directory of its own, absolute inside the Project's sandbox. */
  readonly cwd: string;
  /** The last observed repository hint of `cwd`; absent when it holds none. */
  readonly cwdRepo?: CwdRepo;
  readonly activePromptId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: ThreadOutcome;
};
export type InputSource =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'parent';
      readonly threadId: string;
      readonly promptId: string;
    }
  | {
      readonly kind: 'result';
      readonly threadId: string;
      readonly promptId: string;
      readonly requestPromptId: string;
    };
export type ThreadEvent = {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};
export type ProjectRecord = {
  readonly project: Project;
  readonly snapshot: DoricConfig;
};
export type ThreadRecord = {
  readonly thread: Thread;
  readonly messages: readonly ProviderMessage[];
  readonly checkpoints: Readonly<Record<string, number>>;
};
export type Page<Value> = {
  readonly items: readonly Value[];
  readonly nextCursor?: string;
};
export type DeleteResult = 'deleted' | 'active' | 'missing';
export type ThreadResult =
  | { readonly status: 'created'; readonly thread: Thread }
  | { readonly status: 'missing' | 'inactive' | 'invalid_parent' };
export type PromptResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  | { readonly status: 'missing' | 'inactive' };
export type RewindResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  | {
      readonly status: 'missing' | 'inactive' | 'busy' | 'unknown_prompt';
    };
export type InterruptResult =
  | 'interrupted'
  | 'missing'
  | 'inactive'
  | 'not_running';
/**
 * What moving a Thread's working directory did. A refusal is a value, because it
 * is an answer the agent's tool and the renderer both report rather than a
 * failure they handle.
 */
export type CwdResult =
  | { readonly status: 'updated'; readonly thread: Thread }
  /** The Thread is unknown. */
  | { readonly status: 'missing' }
  /** The Thread's Project has no live sandbox to resolve a path against. */
  | { readonly status: 'inactive' }
  | { readonly status: 'refused'; readonly change: CwdRefusal };
/** The refusals a move can report; `set` is its one success. */
export type CwdRefusal = Exclude<CwdChange, { readonly status: 'set' }>;
/** The Git summary of a Thread's working directory, or why there is none. */
export type ThreadGitResult =
  | { readonly status: 'ready'; readonly git: ThreadGit }
  | { readonly status: 'missing' | 'inactive' };
/** The lease-dependent outcomes every Project subresource can report. */
export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'unavailable'
  | 'expired';
export type ProjectSsh =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly vmId: string;
      readonly ssh: SandboxSshAccess;
    };
export type ProjectFiles =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly SandboxEntry[];
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_directory' };
/**
 * The whole sandbox tree in one read: the root's entries, and each directory's
 * own entries nested inside it. It is what the file tree surface draws, so that
 * opening it reads the workspace once rather than one directory per expansion.
 * A file's content is still read on demand, which is why a node carries no
 * content of its own.
 */
export type ProjectTree =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly SandboxTreeNode[];
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_directory' };
export type ProjectFile =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_file' };
export type ProjectDiff =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path?: string;
      readonly repositories: readonly ProjectChangeSet[];
    }
  | { readonly status: 'invalid_path' | 'not_found' };

/** Durable boundaries; queues and running Agents deliberately stay process-local. */
export interface ProjectStore {
  create(
    name: string,
    snapshot: DoricConfig,
    color: ProjectColor,
  ): Promise<ProjectRecord>;
  find(id: string): Promise<ProjectRecord | undefined>;
  /** The record alone, without the configuration snapshot column. */
  record(id: string): Promise<Project | undefined>;
  list(limit: number, cursor?: string): Promise<Page<Project>>;
  rename(id: string, name: string): Promise<Project | undefined>;
  setColor(
    id: string,
    color: ProjectColor | undefined,
  ): Promise<Project | undefined>;
  setState(
    id: string,
    state: ProjectState,
    errorCode?: string,
  ): Promise<Project | undefined>;
  delete(id: string): Promise<DeleteResult>;
  reconcile(): Promise<number>;
}
export interface ThreadStore {
  /**
   * A new Thread. A child inherits its parent's working directory, and that
   * directory's hint, as a snapshot: both read the same sandbox at the same
   * moment, and each moves independently afterwards.
   */
  create(
    projectId: string,
    name: string,
    parentThreadId?: string,
    inherit?: { readonly cwd: string; readonly cwdRepo?: CwdRepo },
  ): Promise<ThreadRecord>;
  find(id: string): Promise<ThreadRecord | undefined>;
  /** The record alone, without the `messages` and `checkpoints` columns. */
  record(id: string): Promise<Thread | undefined>;
  list(
    projectId: string,
    limit: number,
    cursor?: string,
    parentThreadId?: string,
  ): Promise<Page<Thread>>;
  listByProject(projectId: string): Promise<readonly Thread[]>;
  rename(id: string, name: string): Promise<Thread | undefined>;
  /**
   * Writes the working directory and its hint together, so a stored hint can
   * never describe another directory. An absent hint clears the column.
   */
  setCwd(
    id: string,
    cwd: string,
    cwdRepo?: CwdRepo,
  ): Promise<Thread | undefined>;
  setState(
    id: string,
    state: ThreadState,
    activePromptId?: string,
    errorCode?: string,
  ): Promise<Thread | undefined>;
  saveMessages(id: string, messages: readonly ProviderMessage[]): Promise<void>;
  saveCheckpoint(id: string, promptId: string): Promise<void>;
  /** Removes the prompt's turn and every later one, returning its marker event. */
  rewind(id: string, promptId: string): Promise<ThreadEvent | undefined>;
  appendEvent(
    id: string,
    promptId: string,
    event: unknown,
  ): Promise<ThreadEvent>;
  eventsAfter(id: string, sequence: number): Promise<readonly ThreadEvent[]>;
  /**
   * A bounded, forward page of events after an exclusive cursor, with the next
   * cursor when more remain. It is the agent-facing read; `eventsAfter` stays
   * the whole-log read the UI replays.
   */
  eventsAfterPage(
    id: string,
    sequence: number,
    limit: number,
  ): Promise<{
    readonly events: readonly ThreadEvent[];
    readonly nextSequence?: number;
  }>;
  /** Records the result of a finished prompt, replacing any earlier one. */
  setResult(id: string, result: ThreadOutcome): Promise<void>;
  deleteSubtree(id: string): Promise<DeleteResult>;
  reconcile(): Promise<number>;
}
export interface WorkspacePublisher {
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
  };
  readonly threads: {
    create(
      projectId: string,
      name: string,
      parentThreadId?: string,
    ): Promise<ThreadResult>;
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
    prompt(id: string, prompt: string): Promise<PromptResult>;
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
  sshForVm(
    id: string,
  ): Promise<
    { readonly projectId: string; readonly ssh: SandboxSshAccess } | undefined
  >;
  dispose(): Promise<void>;
}

export const isTerminal = (state: ThreadState): boolean =>
  state === 'cancelled' || state === 'failed';
