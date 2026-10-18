import type { SandboxLease } from 'sandpool';

import type { PromptJob } from '../../contracts/executor.js';
import type { Project, Thread } from '../../contracts/model.js';
import type { GitCredentials } from './git-credentials.js';

/*
 * The process-local runtime of Projects and Threads, moved from agents/doric's
 * workspace/runtime.ts (design 57 §11.1). `ThreadExecution` and the
 * per-generation configuration are replaced by the ports (§4.3), and the
 * stage-4 generation-loss hold is gone: the runner now lives and dies with its
 * generation (cross-review X-12).
 */

/** A failed durable write must stop this conversation, not retry on stale history. */
export class ThreadPersistenceError extends Error {
  constructor(
    cause?: unknown,
    readonly retry?: () => Promise<void>,
  ) {
    super('Thread persistence failed.', { cause });
    this.name = 'ThreadPersistenceError';
  }
}

export type { PromptJob } from '../../contracts/executor.js';

export interface ThreadRuntime {
  /**
   * The Thread's durable record, alive here so that what one prompt's tool does
   * is what the next tool of the same prompt sees — its working directory, for
   * instance.
   */
  thread: Thread;
  readonly jobs: PromptJob[];
  closing: boolean;
  /**
   * Why a deliberate abort is ending this Thread's run. It is set just before
   * the controller aborts, so the run ends as a *pause* the host takes up again
   * instead of as a failure; an explicit termination leaves it unset and stays
   * terminal.
   */
  pausing?: 'host_stopped' | 'reader_stopped' | 'host_restarted';
  /**
   * Set by the reader's stop just before the controller aborts: the run ends
   * its turn as interrupted, keeping the history it wrote, and is not resumed.
   */
  interrupting?: boolean;
  active?: {
    readonly job: PromptJob;
    /** Replaced when a redirect aborts only the current step. */
    controller: AbortController;
    finished?: boolean;
    reported?: boolean;
    /** Resolves once the run has recorded how it ended (or failed to). */
    settled?: Promise<void>;
    /** Steering accepted for this prompt that the executor has not taken. */
    readonly steers: PromptJob[];
    /** Steering the executor took and has not yet recorded, oldest first. */
    readonly taken: PromptJob[];
    /** Set when a steer aborted the current step: the run continues instead. */
    redirect?: boolean;
  };
  task?: Promise<void>;
  ending?: Promise<void>;
  /**
   * Set by termination; resolves once the Thread is written as cancelling, so
   * an aborted run finishes its prompt only after that write.
   */
  leaving?: Promise<void>;
  storagePending?: () => Promise<void>;
}

export interface ProjectRuntime {
  project: Project;
  readonly controller: AbortController;
  readonly threads: Map<string, ThreadRuntime>;
  closing: boolean;
  lease?: SandboxLease;
  /** The credentials this sandbox last received; see `applyCurrentGit`. */
  appliedGit?: GitCredentials;
  /**
   * Set when this runtime was loaded from durable state rather than created in
   * this process. A prompt to a resumed Project waits for its in-flight
   * acquisition before enqueuing, so prompts that race to bring it back keep
   * arrival order; a freshly created Project queues work while it acquires.
   */
  resumed?: boolean;
  acquisition?: Promise<void>;
  ending?: Promise<void>;
}

/** Includes the root, then discovers descendants in stable sibling order. */
export const subtreeIds = (
  threads: readonly Pick<Thread, 'id' | 'parentThreadId'>[],
  rootId: string,
): Set<string> => {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (parentId === undefined) continue;
    const siblings = children.get(parentId);
    if (siblings === undefined) children.set(parentId, [thread.id]);
    else siblings.push(thread.id);
  }
  const ids = new Set([rootId]);
  const pending = [rootId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const child of children.get(id) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      pending.push(child);
    }
  }
  return ids;
};

/** Serializes short lifecycle mutations only, never Agent execution or waiting. */
export const createMutationQueue = () => {
  const tails = new Map<string, Promise<void>>();
  return async <Value>(
    id: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(id) === current) tails.delete(id);
    }
  };
};
