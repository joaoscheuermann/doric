import type { ProviderMessage } from 'llms';
import type { SandboxSshAccess } from 'sandbox';

import type { DoricConfig } from '../config/schema.js';
import type { ProjectColor } from './colors.js';

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
export type Thread = {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly name: string;
  readonly state: ThreadState;
  readonly lastSequence: number;
  readonly activePromptId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
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
export type ProjectSsh =
  | { readonly status: 'pending' | 'unavailable' | 'expired' | 'missing' }
  | {
      readonly status: 'ready';
      readonly vmId: string;
      readonly ssh: SandboxSshAccess;
    };

/** Durable boundaries; queues and running Agents deliberately stay process-local. */
export interface ProjectStore {
  create(name: string, snapshot: DoricConfig): Promise<ProjectRecord>;
  find(id: string): Promise<ProjectRecord | undefined>;
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
  create(
    projectId: string,
    name: string,
    parentThreadId?: string,
  ): Promise<ThreadRecord>;
  find(id: string): Promise<ThreadRecord | undefined>;
  list(
    projectId: string,
    limit: number,
    cursor?: string,
    parentThreadId?: string,
  ): Promise<Page<Thread>>;
  listByProject(projectId: string): Promise<readonly Thread[]>;
  rename(id: string, name: string): Promise<Thread | undefined>;
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
