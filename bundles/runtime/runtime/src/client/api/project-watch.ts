// The selected Project's live tree (stage 9, §5.8): the port of the main
// process's `workspace/project-events.ts` over `runtime/v2.watchProject`.
//
// - One watch per window: a new watch replaces the previous one.
// - There is no cursor: every (re)subscribe delivers a fresh, authoritative
//   snapshot, which the tree replaces wholesale.
// - A notice that names another Project is dropped.
// - A stream that ends with a failure reports `project_stream_failed`,
//   'The Project event stream failed.', over its error and stays ended, as the socket the
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
import { errorFrom } from 'desktop/reads';

import type {
  ProjectWatchInput,
  ProjectWatchItem,
} from '../../contracts/index.js';
import type { ProjectUpdate } from '../domain/tree.js';

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

/**
 * Runs `run` once after `ms` milliseconds on the window's timer; the answer
 * cancels it (a no-op once it ran). The schedule every watch uses outside
 * tests.
 */
export const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** What `followStream` follows and where it reports (§10.8). */
export interface FollowStreamOptions<Item> {
  /** Opens the stream once; called again after each silent end. */
  readonly open: (observer: StreamObserver<Item>) => Disposable;
  readonly connection: ConnectionSource;
  readonly schedule: (run: () => void, ms: number) => () => void;
  readonly onItem: (item: Item) => void;
  /** An end with an error that is not silent; the stream stays ended. */
  readonly onFailure: (error: ContractError) => void;
}

/**
 * Opens the stream and keeps it open: after a silent end it opens it again
 * when the connection reports `connected`, or `resubscribeDelayMs` later when
 * the connection never went down. An end without an error stays ended.
 * Returns the stop.
 *
 * Silent ends are `disconnected`, `unavailable` and `generation_lost`; they
 * report nothing. `open` throwing counts as an end with that error. Items
 * reach `onItem` only from the stream currently open, never after the stop;
 * `onFailure` is called at most once. The stop disposes the open stream and
 * every pending wait, and is idempotent.
 */
export const followStream = <Item>(
  options: FollowStreamOptions<Item>,
): (() => void) => {
  const { open, connection, schedule, onItem, onFailure } = options;
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
    const observer: StreamObserver<Item> = {
      next: (item) => {
        if (!active || ended) return;
        onItem(item);
      },
      end: (error) => {
        if (!active || ended) return;
        ended = true;
        stream = undefined;
        if (silent(error)) {
          waitForConnection();
          return;
        }
        if (error !== undefined) onFailure(error);
      },
    };
    try {
      const opened = open(observer);
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

  subscribe();
  return () => {
    if (!active) return;
    active = false;
    clearWaits();
    stream?.dispose();
    stream = undefined;
  };
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
    let stopped = false;
    let stopStream: (() => void) | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopStream?.();
      if (stopCurrent === stop) stopCurrent = undefined;
    };
    stopCurrent = stop;
    stopStream = followStream<ProjectWatchItem>({
      open: (observer) => runtime.watchProject({ projectId }, observer),
      connection,
      schedule,
      onItem: (item) => {
        const update = projectUpdateOf(projectId, item);
        if (update !== undefined) onUpdate(update);
      },
      onFailure: (error) =>
        onUpdate({
          kind: 'error',
          error: errorFrom('project_stream_failed', projectStreamFailed, error),
        }),
    });
    if (stopped) stopStream();
    return stop;
  };

  return {
    watch,
    close: () => stopCurrent?.(),
  };
};
