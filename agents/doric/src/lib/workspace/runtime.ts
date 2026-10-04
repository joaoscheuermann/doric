import type { Logger } from 'pino';

import type { Host } from 'host';
import type { Sandbox } from 'sandbox';
import type { SandboxLease } from 'sandpool';

import type { Generation } from '../config/generation.js';
import type { GitCredentials } from './git.js';
import type { TerminalRegistry } from './terminals.js';
import type {
  InputSource,
  Project,
  Thread,
  ThreadStore,
  WorkspacePublisher,
} from './types.js';

/** A failed durable write must stop this conversation, not retry on stale history. */
export class ThreadPersistenceError extends Error {
  constructor(cause?: unknown) {
    super('Thread persistence failed.', { cause });
    this.name = 'ThreadPersistenceError';
  }
}

export interface PromptJob {
  readonly id: string;
  readonly prompt: string;
  readonly source: InputSource;
}
export type ThreadExecution = (options: {
  readonly thread: Thread;
  readonly job: PromptJob;
  readonly generation: Generation;
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal;
  readonly store: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly host: Host;
}) => Promise<string>;
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
  pausing?: 'host_stopped' | 'reader_stopped';
  active?: {
    readonly job: PromptJob;
    readonly controller: AbortController;
    finished?: boolean;
    reported?: boolean;
  };
  task?: Promise<void>;
  ending?: Promise<void>;
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
export interface RuntimeContext {
  readonly terminals: TerminalRegistry;
  readonly threads: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly logger: Logger;
  /**
   * The configuration in force right now. A prompt reads it as it runs, so a
   * choice made in the settings reaches the very next prompt of any Project
   * instead of only the Projects created after it.
   */
  readonly generation: () => Generation;
  readonly execute: ThreadExecution;
  readonly exclusive: <Value>(
    id: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
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
