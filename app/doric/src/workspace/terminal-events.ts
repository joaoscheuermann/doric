import type { Manager, Socket } from 'socket.io-client';

import {
  record,
  terminalFrom,
  type TerminalOutputUpdate,
  type TerminalSnapshot,
  type TerminalUpdate,
} from './terminals';

export const terminalUpdateChannel = 'doric:terminals:update';
export const terminalOutputChannel = 'doric:terminals:output';

export type TerminalTarget = {
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
  send(
    channel: string,
    id: string,
    update: TerminalUpdate | TerminalOutputUpdate,
  ): void;
};

type Watch = {
  readonly target: TerminalTarget;
  readonly socket: Socket;
  readonly destroy: () => void;
};
type Options = {
  readonly manager: () => Pick<Manager, 'socket'>;
  readonly snapshot: (id: string) => Promise<TerminalSnapshot>;
};

/** Owns terminal subscriptions independently of conversation replay. */
export const createTerminalEventService = (options: Options) => {
  const watches = new Map<TerminalTarget, Map<string, () => void>>();
  const replace = (
    target: TerminalTarget,
    key: string,
    cleanup: () => void,
  ) => {
    const entries = watches.get(target) ?? new Map<string, () => void>();
    entries.get(key)?.();
    entries.set(key, cleanup);
    watches.set(target, entries);
  };
  const stop = (target: TerminalTarget, key: string) => {
    const entries = watches.get(target);
    entries?.get(key)?.();
    entries?.delete(key);
    if (entries?.size === 0) watches.delete(target);
  };
  const connect = (
    target: TerminalTarget,
    projectId: string,
    destroy: () => void,
  ): Watch => {
    const socket = options
      .manager()
      .socket('/projects', { auth: { projectId } });
    socket.auth = { projectId };
    target.once('destroyed', destroy);
    return { target, socket, destroy };
  };
  const dispose = (watch: Watch) => {
    watch.target.off('destroyed', watch.destroy);
    watch.socket.removeAllListeners();
    watch.socket.disconnect();
  };

  return {
    watchProject(target: TerminalTarget, projectId: string) {
      const key = `project:${projectId}`;
      const watch = connect(target, projectId, () => stop(target, key));
      let active = true;
      replace(target, key, () => {
        active = false;
        dispose(watch);
      });
      const send = (update: TerminalUpdate) => {
        if (active && !target.isDestroyed())
          target.send(terminalUpdateChannel, projectId, update);
      };
      watch.socket.on('terminal:snapshot', (value: unknown) => {
        const item = record(value);
        if (item?.projectId !== projectId || !Array.isArray(item.terminals))
          return;
        try {
          const terminals = item.terminals
            .map(terminalFrom)
            .filter((terminal) => terminal.projectId === projectId);
          send({ kind: 'snapshot', terminals });
        } catch {
          send({
            kind: 'error',
            message: 'The terminal list could not be read.',
          });
        }
      });
      watch.socket.on('terminal:updated', (value: unknown) => {
        if (record(value)?.projectId !== projectId) return;
        try {
          send({ kind: 'updated', terminal: terminalFrom(value) });
        } catch {
          send({ kind: 'error', message: 'The terminal could not be read.' });
        }
      });
      watch.socket.on('terminal:removed', (value: unknown) => {
        const item = record(value);
        if (
          item?.projectId === projectId &&
          typeof item.terminalId === 'string'
        )
          send({ kind: 'removed', terminalId: item.terminalId });
      });
      watch.socket.on('connect_error', () =>
        send({ kind: 'error', message: 'The terminal connection failed.' }),
      );
      watch.socket.connect();
    },
    stopProject: (target: TerminalTarget, projectId: string) =>
      stop(target, `project:${projectId}`),
    watch(target: TerminalTarget, id: string) {
      const key = `terminal:${id}`;
      let active = true;
      let watch: Watch | undefined;
      let generation = 0;
      let cursor = 0;
      let pending: { data: string; offset: number }[] | undefined = [];
      let pendingLength = 0;
      const destroyed = () => stop(target, key);
      target.once('destroyed', destroyed);
      replace(target, key, () => {
        active = false;
        generation++;
        target.off('destroyed', destroyed);
        if (watch) dispose(watch);
      });
      const send = (update: TerminalOutputUpdate) => {
        if (active && !target.isDestroyed())
          target.send(terminalOutputChannel, id, update);
      };
      const output = (chunk: { data: string; offset: number }) => {
        if (chunk.offset <= cursor) return;
        if (chunk.offset - chunk.data.length > cursor) {
          void refresh();
          return;
        }
        const data = chunk.data.slice(
          Math.max(0, cursor - (chunk.offset - chunk.data.length)),
        );
        cursor = chunk.offset;
        send({ kind: 'output', data, sequence: cursor });
      };
      const refresh = async () => {
        const attempt = ++generation;
        pending = [];
        pendingLength = 0;
        try {
          const snapshot = await options.snapshot(id);
          if (!active || attempt !== generation) return;
          cursor = snapshot.offset;
          send({
            kind: 'snapshot',
            data: snapshot.output,
            sequence: cursor,
            truncated: snapshot.truncated,
          });
          const chunks = pending;
          pending = undefined;
          chunks?.forEach(output);
        } catch {
          if (active && attempt === generation)
            send({
              kind: 'error',
              message: 'The terminal is no longer available.',
            });
        }
      };
      void options
        .snapshot(id)
        .then((snapshot) => {
          if (!active || target.isDestroyed()) return;
          const projectId = snapshot.terminal.projectId;
          target.off('destroyed', destroyed);
          watch = connect(target, projectId, () => stop(target, key));
          watch.socket.on('terminal:snapshot', (value: unknown) => {
            if (record(value)?.projectId === projectId) void refresh();
          });
          watch.socket.on('disconnect', () => {
            generation++;
            pending = [];
          });
          watch.socket.on('terminal:output', (value: unknown) => {
            const item = record(value);
            if (
              item?.projectId !== projectId ||
              item.terminalId !== id ||
              typeof item.data !== 'string' ||
              !Number.isSafeInteger(item.offset) ||
              Number(item.offset) < item.data.length
            )
              return;
            const chunk = { data: item.data, offset: item.offset as number };
            if (pending) {
              pending.push(chunk);
              pendingLength += chunk.data.length;
              // A slow snapshot must not let an unbounded output queue grow.
              if (pendingLength > 2_097_152) void refresh();
            } else output(chunk);
          });
          watch.socket.on('connect_error', () =>
            send({ kind: 'error', message: 'The terminal connection failed.' }),
          );
          watch.socket.connect();
        })
        .catch(() =>
          send({
            kind: 'error',
            message: 'The terminal is no longer available.',
          }),
        );
    },
    stop: (target: TerminalTarget, id: string) =>
      stop(target, `terminal:${id}`),
    close() {
      for (const entries of watches.values())
        for (const cleanup of entries.values()) cleanup();
      watches.clear();
    },
  };
};

export type TerminalEventService = ReturnType<
  typeof createTerminalEventService
>;
