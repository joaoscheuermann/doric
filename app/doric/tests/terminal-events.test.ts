import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Socket } from 'socket.io-client';

import {
  createTerminalEventService,
  type TerminalTarget,
  terminalOutputChannel,
} from '../src/workspace/terminal-events';
import type {
  TerminalOutputUpdate,
  TerminalSnapshot,
  TerminalUpdate,
} from '../src/workspace/terminals';

const terminal = {
  id: 'terminal',
  projectId: 'project',
  threadId: 'thread',
  origin: 'agent' as const,
  command: 'build',
  cwd: '/workspace',
  startedAt: '2026-10-03T00:00:00Z',
  timeoutMs: 1000,
  state: 'running' as const,
  pty: false,
};
const snapshot = (output: string): TerminalSnapshot => ({
  terminal,
  output,
  offset: output.length,
  truncated: false,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const setup = (read: () => Promise<TerminalSnapshot>) => {
  const sockets: ReturnType<typeof socket>[] = [];
  const updates: {
    channel: string;
    id: string;
    update: TerminalUpdate | TerminalOutputUpdate;
  }[] = [];
  const destroyed = new Set<() => void>();
  const target: TerminalTarget = {
    once: (_event, listener) => {
      destroyed.add(listener);
    },
    off: (_event, listener) => {
      destroyed.delete(listener);
    },
    isDestroyed: () => false,
    send: (channel, id, update) => {
      updates.push({ channel, id, update });
    },
  };
  const service = createTerminalEventService({
    snapshot: read,
    manager: () => ({
      socket: () => {
        const item = socket();
        sockets.push(item);
        return item as unknown as Socket;
      },
    }),
  });
  return { service, sockets, updates, target, destroyed };
};
const socket = () => {
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    auth: {},
    connected: false,
    on(name: string, listener: (value: unknown) => void) {
      listeners.set(name, listener);
    },
    emit(name: string, value: unknown) {
      listeners.get(name)?.(value);
    },
    connect() {
      this.connected = true;
    },
    disconnect() {
      this.connected = false;
    },
    removeAllListeners() {
      listeners.clear();
    },
  };
};

test('reconciles output received during snapshot without duplicating overlapping text', async () => {
  let resolveRead!: (value: TerminalSnapshot) => void;
  let first = true;
  const fixture = setup(() => {
    if (first) {
      first = false;
      return Promise.resolve(snapshot(''));
    }
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  });
  fixture.service.watch(fixture.target, terminal.id);
  await tick();
  const connection = fixture.sockets[0];
  connection.emit('terminal:snapshot', {
    projectId: 'project',
    terminals: [terminal],
  });
  connection.emit('terminal:output', {
    projectId: 'project',
    terminalId: 'terminal',
    data: 'hello world',
    offset: 11,
  });
  resolveRead(snapshot('hello'));
  await tick();
  assert.deepEqual(
    fixture.updates.map(({ update }) => update),
    [
      { kind: 'snapshot', data: 'hello', sequence: 5, truncated: false },
      { kind: 'output', data: ' world', sequence: 11 },
    ],
  );
  assert.equal(fixture.updates[0].channel, terminalOutputChannel);
  connection.emit('terminal:output', {
    projectId: 'elsewhere',
    terminalId: 'terminal',
    data: 'secret',
    offset: 17,
  });
  connection.emit('terminal:output', {
    projectId: 'project',
    terminalId: 'terminal',
    data: 'hello world',
    offset: 11,
  });
  assert.equal(fixture.updates.length, 2);
  fixture.service.close();
});

test('reconnect replaces the transcript and a stopped watch cannot publish late reads', async () => {
  let current = snapshot('first');
  const fixture = setup(async () => current);
  fixture.service.watch(fixture.target, terminal.id);
  await tick();
  const connection = fixture.sockets[0];
  connection.emit('terminal:snapshot', { projectId: 'project' });
  await tick();
  connection.emit('disconnect', undefined);
  current = snapshot('first and second');
  connection.emit('terminal:snapshot', { projectId: 'project' });
  await tick();
  assert.deepEqual(fixture.updates.at(-1)?.update, {
    kind: 'snapshot',
    data: 'first and second',
    sequence: 16,
    truncated: false,
  });
  connection.emit('terminal:snapshot', { projectId: 'project' });
  const count = fixture.updates.length;
  fixture.service.stop(fixture.target, terminal.id);
  await tick();
  assert.equal(fixture.updates.length, count);
  assert.equal(connection.connected, false);
  assert.equal(fixture.destroyed.size, 0);
});

test('a project terminal watch filters other projects and stops on window destruction', () => {
  const fixture = setup(async () => snapshot(''));
  fixture.service.watchProject(fixture.target, 'project');
  const connection = fixture.sockets[0];
  connection.emit('terminal:updated', { ...terminal, projectId: 'other' });
  connection.emit('terminal:snapshot', {
    projectId: 'project',
    terminals: [terminal],
  });
  connection.emit('terminal:removed', {
    projectId: 'project',
    terminalId: 'terminal',
  });
  assert.deepEqual(
    fixture.updates.map(({ update }) => update),
    [
      { kind: 'snapshot', terminals: [terminal] },
      { kind: 'removed', terminalId: 'terminal' },
    ],
  );
  for (const destroy of fixture.destroyed) destroy();
  assert.equal(connection.connected, false);
});
