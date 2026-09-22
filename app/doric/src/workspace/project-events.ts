import type { Manager, Socket } from 'socket.io-client';

import type { Project, Thread } from './api';

export type ProjectSnapshot = {
  readonly projectId: string;
  readonly project: Project | null;
  readonly threads: readonly Thread[];
};

export type ProjectUpdate =
  | { readonly kind: 'snapshot'; readonly snapshot: ProjectSnapshot }
  | { readonly kind: 'thread-updated'; readonly thread: Thread }
  | {
      readonly kind: 'thread-deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'project-updated'; readonly project: Project }
  | { readonly kind: 'project-deleted'; readonly projectId: string }
  | { readonly kind: 'error'; readonly message: string };

export type ProjectEventTarget = {
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
  send(channel: string, update: ProjectUpdate): void;
};

export type ProjectEventService = {
  watch(target: ProjectEventTarget, projectId: string): void;
  stop(target: ProjectEventTarget): void;
  close(): void;
};

export const projectUpdateChannel = 'doric:projects:update';

/** The only message a renderer ever receives for a failed Project stream. */
const failed = 'The Project event stream failed.';

type Selected = {
  readonly target: ProjectEventTarget;
  readonly socket: Socket;
  readonly destroyed: () => void;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Forwards the selected Project's Thread tree to one renderer while it stays
 * open. There is no cursor: every (re)connect delivers a fresh, authoritative
 * snapshot, so the renderer simply replaces its cached tree each time.
 */
export const createProjectEventService = (
  manager: Pick<Manager, 'socket'>,
): ProjectEventService => {
  let selected: Selected | undefined;

  const stop = (subscription?: Selected): void => {
    if (
      selected === undefined ||
      (subscription !== undefined && selected !== subscription)
    )
      return;
    const current = selected;
    selected = undefined;
    current.target.off('destroyed', current.destroyed);
    current.socket.removeAllListeners();
    current.socket.disconnect();
  };

  const send = (current: Selected, update: ProjectUpdate): void => {
    if (selected === current && !current.target.isDestroyed()) {
      current.target.send(projectUpdateChannel, update);
    }
  };

  return {
    watch: (target, projectId) => {
      stop();
      const socket = manager.socket('/projects', { auth: { projectId } });
      socket.auth = { projectId };
      // A stale cleanup only ever stops the subscription that created it.
      const destroyed = (): void => stop(current);
      const current: Selected = { target, socket, destroyed };
      selected = current;
      target.once('destroyed', destroyed);

      socket.on('project:snapshot', (value: unknown) => {
        const snapshot = record(value);
        if (snapshot === undefined || !Array.isArray(snapshot.threads)) {
          send(current, { kind: 'error', message: failed });
          return;
        }
        send(current, { kind: 'snapshot', snapshot: value as ProjectSnapshot });
      });
      socket.on('thread:updated', (value: unknown) => {
        send(current, { kind: 'thread-updated', thread: value as Thread });
      });
      socket.on('thread:deleted', (value: unknown) => {
        const deleted = record(value);
        if (
          typeof deleted?.projectId === 'string' &&
          typeof deleted.threadId === 'string'
        ) {
          send(current, {
            kind: 'thread-deleted',
            projectId: deleted.projectId,
            threadId: deleted.threadId,
          });
        }
      });
      socket.on('project:updated', (value: unknown) => {
        send(current, { kind: 'project-updated', project: value as Project });
      });
      socket.on('project:deleted', (value: unknown) => {
        const deleted = record(value);
        if (typeof deleted?.projectId === 'string') {
          send(current, {
            kind: 'project-deleted',
            projectId: deleted.projectId,
          });
        }
      });
      socket.on('workspace:error', () => {
        // The raw payload never crosses the main-process boundary.
        send(current, { kind: 'error', message: failed });
      });
      socket.connect();
    },
    stop: (target) => {
      if (selected?.target === target) stop();
    },
    close: () => stop(),
  };
};
