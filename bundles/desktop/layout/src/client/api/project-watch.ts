// The selected Project's live tree (stage 9, §5.8): the port of the main
// process's `workspace/project-events.ts` over `runtime/v1.watchProject`.
//
// - One watch per window: a new watch replaces the previous one.
// - There is no cursor: every (re)subscribe delivers a fresh, authoritative
//   snapshot, which the tree replaces wholesale.
// - A notice that names another Project is dropped.
// - A stream that ends with a failure reports
//   'The Project event stream failed.' and stays ended, as the socket the
//   host disconnected after `workspace:error` did.
// - A dropped connection (`disconnected`, `unavailable`) or a lost host
//   generation (`generation_lost`) reports nothing and subscribes again, the
//   way Socket.IO reconnected: when the connection reports `connected`, or
//   after one second when it never went down.

import {
  type ConnectionStatus,
  type ContractError,
  type Disposable,
  isContractError,
  type StreamObserver,
} from 'bundle/contracts';
import type { ProjectWatchInput, ProjectWatchItem } from 'runtime/contracts';

import type { ProjectUpdate } from '../domain/workspace.js';

/** The only message a window ever receives for a failed Project stream. */
export const projectStreamFailed = 'The Project event stream failed.';

/** The delay before subscribing again while the connection stays up. */
export const resubscribeDelayMs = 1000;

export interface ProjectWatchSource {
  watchProject(
    input: ProjectWatchInput,
    listener: StreamObserver<ProjectWatchItem>,
  ): Disposable;
}

export interface ConnectionSource {
  status(): ConnectionStatus;
  subscribe(listener: (status: ConnectionStatus) => void): Disposable;
}

export interface ProjectWatchOptions {
  readonly runtime: ProjectWatchSource;
  readonly connection: ConnectionSource;
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export interface ProjectWatch {
  /** Follows one Project; returns the stop of this watch only. */
  watch(
    projectId: string,
    onUpdate: (update: ProjectUpdate) => void,
  ): () => void;
  /** Stops the current watch, if any. */
  close(): void;
}

const silent = (error: ContractError | undefined): boolean =>
  isContractError(error) &&
  ['disconnected', 'unavailable', 'generation_lost'].includes(error.code);

/** The update an item is for `projectId`, or undefined when it is another's. */
export const projectUpdateOf = (
  projectId: string,
  item: ProjectWatchItem,
): ProjectUpdate | undefined => {
  switch (item.kind) {
    case 'snapshot':
      return item.projectId === projectId
        ? {
            kind: 'snapshot',
            snapshot: {
              projectId: item.projectId,
              project: item.project,
              threads: item.threads,
            },
          }
        : undefined;
    case 'thread-updated':
      return item.thread.projectId === projectId
        ? { kind: 'thread-updated', thread: item.thread }
        : undefined;
    case 'thread-deleted':
      return item.projectId === projectId
        ? { kind: 'thread-deleted', projectId, threadId: item.threadId }
        : undefined;
    case 'project-updated':
      return item.project.id === projectId
        ? { kind: 'project-updated', project: item.project }
        : undefined;
    case 'project-deleted':
      return item.projectId === projectId
        ? { kind: 'project-deleted', projectId }
        : undefined;
  }
};

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export const createProjectWatch = ({
  runtime,
  connection,
  schedule = defaultSchedule,
}: ProjectWatchOptions): ProjectWatch => {
  let stopCurrent: (() => void) | undefined;

  const watch = (
    projectId: string,
    onUpdate: (update: ProjectUpdate) => void,
  ): (() => void) => {
    stopCurrent?.();
    let active = true;
    let stream: Disposable | undefined;
    let waiting: Disposable | undefined;
    let cancelTimer: (() => void) | undefined;

    const clearWaits = () => {
      waiting?.dispose();
      waiting = undefined;
      cancelTimer?.();
      cancelTimer = undefined;
    };

    const subscribe = () => {
      clearWaits();
      if (!active) return;
      let ended = false;
      const observer: StreamObserver<ProjectWatchItem> = {
        next: (item) => {
          if (!active || ended) return;
          const update = projectUpdateOf(projectId, item);
          if (update !== undefined) onUpdate(update);
        },
        end: (error) => {
          if (!active || ended) return;
          ended = true;
          stream = undefined;
          if (silent(error)) {
            waitForConnection();
            return;
          }
          if (error !== undefined) {
            onUpdate({ kind: 'error', message: projectStreamFailed });
          }
        },
      };
      try {
        const opened = runtime.watchProject({ projectId }, observer);
        if (ended || !active) opened.dispose();
        else stream = opened;
      } catch (error) {
        observer.end?.(error as ContractError);
      }
    };

    const waitForConnection = () => {
      clearWaits();
      waiting = connection.subscribe((status) => {
        if (status === 'connected') subscribe();
      });
      if (connection.status() === 'connected') {
        cancelTimer = schedule(subscribe, resubscribeDelayMs);
      }
    };

    const stop = () => {
      if (!active) return;
      active = false;
      clearWaits();
      stream?.dispose();
      stream = undefined;
      if (stopCurrent === stop) stopCurrent = undefined;
    };

    stopCurrent = stop;
    subscribe();
    return stop;
  };

  return {
    watch,
    close: () => stopCurrent?.(),
  };
};

let current: ProjectWatch | undefined;

/** Binds the window's one Project watch to the layout's activation services. */
export const initProjectWatch = (options: ProjectWatchOptions): void => {
  current?.close();
  current = createProjectWatch(options);
};

export const disposeProjectWatch = (): void => {
  current?.close();
  current = undefined;
};

/** The window's Project watch; a no-op before activation. */
export const projectWatch = (): ProjectWatch =>
  current ?? { watch: () => () => undefined, close: () => undefined };
