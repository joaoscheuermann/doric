import type { Logger } from 'pino';
import type { Sandbox } from 'sandbox';
import type { SandboxLease } from 'sandpool';

import type { ThreadCoordination } from './coordination.js';
import type { Generation } from '../config/generation.js';
import type {
  InputSource,
  Project,
  Thread,
  ThreadStore,
  WorkspacePublisher,
} from './types.js';

/** A failed durable write must stop this conversation, not retry on stale history. */
export class ThreadPersistenceError extends Error {
  constructor() {
    super('Thread persistence failed.');
    this.name = 'ThreadPersistenceError';
  }
}

export type PromptJob = {
  readonly id: string;
  readonly prompt: string;
  readonly source: InputSource;
};
export type ThreadExecution = (options: {
  readonly thread: Thread;
  readonly job: PromptJob;
  readonly generation: Generation;
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal;
  readonly store: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly coordination: ThreadCoordination;
}) => Promise<string>;
export type ThreadRuntime = {
  thread: Thread;
  readonly jobs: PromptJob[];
  closing: boolean;
  active?: {
    readonly job: PromptJob;
    readonly controller: AbortController;
    finished?: boolean;
    reported?: boolean;
  };
  task?: Promise<void>;
  ending?: Promise<void>;
};
export type ProjectRuntime = {
  project: Project;
  readonly generation: Generation;
  readonly controller: AbortController;
  readonly threads: Map<string, ThreadRuntime>;
  closing: boolean;
  lease?: SandboxLease;
  acquisition?: Promise<void>;
  ending?: Promise<void>;
};
export type RuntimeContext = {
  readonly threads: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly logger: Logger;
  readonly execute: ThreadExecution;
  readonly exclusive: <Value>(
    id: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
};

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
