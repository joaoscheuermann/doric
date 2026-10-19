// The workspace records the conversation reads, as the renderer typed them
// (`app/desktop/doric-renderer/src/domain/workspace.ts`). The chat keeps its own copy
// so the projection, the store and the cache see the exact shapes they saw
// over the semantic preload; the layout owns the Project/Thread tree helpers.

/** A Project as a Thread snapshot carries it; `color` is the host's palette name. */
export type Project = {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Thread = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  /**
   * Who opened the Thread: a reader (`'user'`) or the agent that spawned it
   * (`'agent'`). Absent on a Thread written before the host recorded it, which
   * reads as the reader's.
   */
  readonly origin?: 'user' | 'agent';
  readonly state: string;
  /** The prompt the Thread is running, present only while one is. */
  readonly activePromptId?: string;
  /** Start of the current execution, or duration of the last completed execution. */
  readonly executionStartedAt?: string;
  readonly lastExecutionMs?: number;
  /** The Thread's working directory, absolute inside the sandbox. */
  readonly cwd: string;
  /**
   * The repository the cwd root is, as the host read it from the disk alone:
   * `'github'` only when the `origin` remote is on github.com. Absent when the
   * root holds no `.git` entry.
   */
  readonly cwdRepo?: 'git' | 'github';
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Whether an agent spawned this Thread and holds its control: the reader may
 * watch it, pause it, continue it and retry it, and nothing else. A Thread
 * without `origin` is the reader's, so an old workspace controls as it always
 * did.
 */
export const isAgentThread = (thread: Thread | undefined): boolean =>
  thread !== undefined &&
  thread.parentThreadId !== undefined &&
  thread.origin === 'agent';

export type ThreadEvent = {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};

export type ThreadUpdate =
  | {
      readonly kind: 'snapshot';
      readonly snapshot: {
        readonly threadId: string;
        readonly projectId: string | null;
        readonly project: Project | null;
        readonly thread: Thread | null;
        readonly events: readonly ThreadEvent[];
      };
    }
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'updated'; readonly thread: Thread }
  | {
      readonly kind: 'deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  /**
   * A stream failure, named for the Thread whose watch raised it, so a surface
   * draws it in that Thread's conversation and in no other.
   */
  | {
      readonly kind: 'error';
      readonly threadId: string;
      readonly message: string;
    };

/**
 * The app's best-effort local snapshot of one Thread's durable log: its
 * record, the events held, and the sequence a subscription resumes from. A
 * `null` answer means the app holds none, never that the Thread is empty.
 */
export type ThreadHistory = {
  readonly thread: Thread | null;
  readonly lastSequence: number;
  readonly events: readonly ThreadEvent[];
};
