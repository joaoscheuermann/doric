import type { Logger } from 'pino';
import type { Sandbox } from 'sandbox';
import type { SandboxLease } from 'sandpool';

import type { ThreadCoordination } from './coordination.js';
import type { Generation } from '../config/generation.js';
import type {
  InputSource,
  Project,
  ProjectStore,
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
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly logger: Logger;
  readonly execute: ThreadExecution;
  readonly exclusive: <Value>(
    id: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
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
