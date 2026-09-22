import type { Manager, Socket } from 'socket.io-client';

import type { Project, Thread } from './api';

export type ThreadEvent = {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};

export type ThreadSnapshot = {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly project: Project | null;
  readonly thread: Thread | null;
  readonly events: readonly ThreadEvent[];
};

export type ThreadUpdate =
  | { readonly kind: 'snapshot'; readonly snapshot: ThreadSnapshot }
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'updated'; readonly thread: Thread }
  | {
      readonly kind: 'deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'error'; readonly message: string };

export type ThreadEventTarget = {
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
  send(channel: string, update: ThreadUpdate): void;
};

export type ThreadEventService = {
  watch(
    target: ThreadEventTarget,
    threadId: string,
    afterSequence: number,
  ): void;
  stop(target: ThreadEventTarget): void;
  close(): void;
};

export const threadUpdateChannel = 'doric:threads:update';

type Selected = {
  readonly target: ThreadEventTarget;
  readonly socket: Socket;
  readonly destroyed: () => void;
  cursor: number;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const eventSequence = (value: unknown): number | undefined => {
  const sequence = record(value)?.sequence;
  return typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? sequence
    : undefined;
};

const errorMessage = (value: unknown): string => {
  const error = record(value);
  return typeof error?.code === 'string' &&
    error.code.length > 0 &&
    typeof error.message === 'string' &&
    error.message.length > 0
    ? error.message
    : 'The Thread event stream failed.';
};

/** Forwards one selected Thread while retaining the durable cursor for reconnects. */
export const createThreadEventService = (
  manager: Pick<Manager, 'socket'>,
): ThreadEventService => {
  let selected: Selected | undefined;

  const stop = (target?: ThreadEventTarget): void => {
    if (
      selected === undefined ||
      (target !== undefined && selected.target !== target)
    )
      return;
    const current = selected;
    selected = undefined;
    current.target.off('destroyed', current.destroyed);
    current.socket.removeAllListeners();
    current.socket.disconnect();
  };

  const send = (current: Selected, update: ThreadUpdate): void => {
    if (selected === current && !current.target.isDestroyed()) {
      current.target.send(threadUpdateChannel, update);
    }
  };

  return {
    watch: (target, threadId, afterSequence) => {
      stop();
      const socket = manager.socket('/threads', {
        auth: { threadId, afterSequence },
      });
      socket.auth = { threadId, afterSequence };
      const destroyed = (): void => stop(target);
      const current: Selected = {
        target,
        socket,
        destroyed,
        cursor: afterSequence,
      };
      selected = current;
      target.once('destroyed', destroyed);

      socket.on('thread:snapshot', (value: unknown) => {
        const snapshot = record(value);
        if (snapshot === undefined || !Array.isArray(snapshot.events)) {
          send(current, {
            kind: 'error',
            message: 'The Thread event stream returned an invalid snapshot.',
          });
          return;
        }
        for (const event of snapshot.events) {
          const sequence = eventSequence(event);
          if (sequence !== undefined)
            current.cursor = Math.max(current.cursor, sequence);
        }
        socket.auth = { threadId, afterSequence: current.cursor };
        send(current, {
          kind: 'snapshot',
          snapshot: value as ThreadSnapshot,
        });
      });
      socket.on('agent:event', (value: unknown) => {
        const sequence = eventSequence(value);
        if (sequence === undefined) {
          send(current, {
            kind: 'error',
            message: 'The Thread event stream returned an invalid event.',
          });
          return;
        }
        current.cursor = Math.max(current.cursor, sequence);
        socket.auth = { threadId, afterSequence: current.cursor };
        send(current, { kind: 'event', event: value as ThreadEvent });
      });
      socket.on('thread:updated', (value: unknown) => {
        send(current, { kind: 'updated', thread: value as Thread });
      });
      socket.on('thread:deleted', (value: unknown) => {
        const deleted = record(value);
        if (
          typeof deleted?.projectId === 'string' &&
          typeof deleted.threadId === 'string'
        ) {
          send(current, {
            kind: 'deleted',
            projectId: deleted.projectId,
            threadId: deleted.threadId,
          });
        }
      });
      socket.on('workspace:error', (value: unknown) => {
        send(current, { kind: 'error', message: errorMessage(value) });
      });
      socket.connect();
    },
    stop,
    close: () => stop(),
  };
};
