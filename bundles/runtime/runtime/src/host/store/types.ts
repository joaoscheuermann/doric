import type { DoricConfiguration } from '../../contracts/configuration.js';
import type { HistoryPatch, HistoryReader } from '../../contracts/executor.js';
import type {
  CwdRepo,
  DeleteResult,
  InputSource,
  Page,
  Project,
  ProjectColor,
  ProjectState,
  Thread,
  ThreadEvent,
  ThreadOutcome,
  ThreadQueue,
  ThreadState,
  ThreadUsage,
} from '../../contracts/model.js';
import type { RuntimeOwner } from '../../contracts/runtime.js';

/*
 * The durable boundaries of the runtime domain (design 57 §3, §4.1), frozen by
 * 57-WP-0 so the store (57-WP-R1) and the domain (57-WP-R2) build against one
 * shape. They are agents/doric's ProjectStore and ThreadStore without the
 * Prisma `messages` and `checkpoints` columns: the executor's history is the
 * opaque `runtime.history/v1` state read and written through `HistoryReader`
 * and `HistoryPatch`.
 */

/** Why an interruption left a prompt unfinished. */
export type PauseReason =
  | 'host_stopped'
  | 'host_restarted'
  | 'reader_stopped'
  | 'storage_low';

/** What the durable log says about one prompt that has not finished. */
export interface PromptProgress {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  /** The input `prompt.accepted` recorded, after credential redaction. */
  readonly text: string;
  /** Sequence of the acceptance or most recent edit. */
  readonly revision?: number;
  readonly source: InputSource;
  /** Whether a run of this prompt ever started. */
  readonly started: boolean;
  /** The pause that still stands. */
  readonly paused?: PauseReason;
  /** A newer user input replaced this paused prompt. */
  readonly superseded?: boolean;
  /** How many times the host already took this prompt up again. */
  readonly attempts: number;
  readonly acceptedAt?: string;
  readonly queuedSequence?: number;
  readonly pausedSequence?: number;
  readonly first?: boolean;
}

/** The failure a prompt the host gives up on is closed with. */
export interface PromptFailure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

/** A Project with the configuration it was created under. */
export interface ProjectRecord {
  readonly project: Project;
  /** The full configuration at create, verbatim. */
  readonly snapshot: DoricConfiguration;
}

/** A Thread's record; its executor history is read through `history`. */
export interface ThreadRecord {
  readonly thread: Thread;
}

export interface ProjectStore {
  /** `owner` is the creating runtime process (57-WP-H), when it knows one. */
  create(
    name: string,
    snapshot: DoricConfiguration,
    color: ProjectColor,
    owner?: RuntimeOwner,
  ): Promise<ProjectRecord>;
  find(id: string): Promise<ProjectRecord | undefined>;
  /** The record alone, without the configuration snapshot. */
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
  /** Only the open Projects `include` accepts; every one without it. */
  reconcile(include?: (projectId: string) => boolean): Promise<number>;
  /**
   * The owner of every open Project, by id (57-WP-H); null when none is
   * recorded.
   */
  owners(): Promise<ReadonlyMap<string, RuntimeOwner | null>>;
  /**
   * Records `owner` as the Project's runtime process unless `live` says its
   * current owner is another process still alive; whether `owner` holds it.
   * The write does not move `updatedAt`.
   */
  claim(
    id: string,
    owner: RuntimeOwner,
    live: (current: RuntimeOwner) => boolean,
  ): Promise<boolean>;
  /** Clears the owner while it is still `owner`, without moving `updatedAt`. */
  release(id: string, owner: RuntimeOwner): Promise<void>;
}

export interface ThreadStore {
  queue(id: string): Promise<ThreadQueue | undefined>;
  usage(id: string): Promise<ThreadUsage | undefined>;
  /** A child inherits its parent's working directory and hint as a snapshot. */
  create(
    projectId: string,
    name: string,
    parentThreadId?: string,
    inherit?: { readonly cwd: string; readonly cwdRepo?: CwdRepo },
  ): Promise<ThreadRecord>;
  find(id: string): Promise<ThreadRecord | undefined>;
  record(id: string): Promise<Thread | undefined>;
  list(
    projectId: string,
    limit: number,
    cursor?: string,
    parentThreadId?: string,
  ): Promise<Page<Thread>>;
  listByProject(projectId: string): Promise<readonly Thread[]>;
  rename(id: string, name: string): Promise<Thread | undefined>;
  /** Writes the working directory and its hint together; no hint clears it. */
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
  /** The Thread's executor history; replaces reading `messages`/`checkpoints`. */
  history(id: string): Promise<HistoryReader>;
  /** `session.record({ history })`: puts the parts and bumps `updatedAt` (saveMessages). */
  saveHistory(id: string, patch: HistoryPatch): Promise<void>;
  /** The executor's checkpoint patch; no `updatedAt` bump (saveCheckpoint). */
  saveCheckpoint(id: string, patch: HistoryPatch): Promise<void>;
  /**
   * Removes the prompt's turn and every later one, with the executor's
   * rewind patch in the same commit, returning its marker event; undefined
   * when the prompt has no checkpoint or no event.
   */
  rewind(id: string, promptId: string): Promise<ThreadEvent | undefined>;
  appendEvent(
    id: string,
    promptId: string,
    event: unknown,
  ): Promise<ThreadEvent>;
  /** Commits related lifecycle events together, before any live publication. */
  appendEvents(
    id: string,
    promptId: string,
    events: readonly unknown[],
  ): Promise<readonly ThreadEvent[]>;
  eventsAfter(id: string, sequence: number): Promise<readonly ThreadEvent[]>;
  eventsAfterPage(
    id: string,
    sequence: number,
    limit: number,
  ): Promise<{
    readonly events: readonly ThreadEvent[];
    readonly nextSequence?: number;
  }>;
  setResult(id: string, result: ThreadOutcome): Promise<void>;
  /** Every unfinished prompt in log order, or one Thread's alone. */
  unfinishedPrompts(id?: string): Promise<readonly PromptProgress[]>;
  /** Closes one unfinished prompt as a failure, in the shape a run leaves. */
  failPrompt(prompt: PromptProgress, failure: PromptFailure): Promise<void>;
  deleteSubtree(id: string): Promise<DeleteResult>;
  /** Only the Threads of Projects `include` accepts; every one without it. */
  reconcile(include?: (projectId: string) => boolean): Promise<number>;
}
