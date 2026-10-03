import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import type { Manager, Socket } from 'socket.io-client';

import {
  createThreadEventService,
  type ThreadEventTarget,
  type ThreadUpdate,
  threadUpdateChannel,
} from '../src/workspace/events';
import { createThreadHistoryStore } from '../src/workspace/thread-history';

class FakeSocket {
  auth: Record<string, unknown> = {};
  connected = false;
  disconnects = 0;
  connects = 0;
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, listener: (value: unknown) => void): this {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return this;
  }

  emit(name: string, value: unknown): void {
    this.listeners.get(name)?.forEach((listener) => listener(value));
  }

  connect(): this {
    this.connected = true;
    this.connects += 1;
    return this;
  }

  disconnect(): this {
    this.connected = false;
    this.disconnects += 1;
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
}

/** One connection, as a watch opens it: a Manager of its own, one namespace. */
class FakeConnection {
  readonly socket = new FakeSocket();

  namespace = '';
  options: unknown;

  create(namespace: string, options: unknown): Socket {
    this.namespace = namespace;
    this.options = options;
    return this.socket as unknown as Socket;
  }
}

/** The connection factory a Thread watch is given: a fresh connection per watch. */
class FakeConnections {
  readonly opened: FakeConnection[] = [];

  /** The connection the most recent watch opened. */
  get latest(): FakeConnection {
    const connection = this.opened.at(-1);
    assert.ok(connection !== undefined, 'no connection was opened');
    return connection;
  }

  get disconnects(): number {
    return this.opened.reduce(
      (total, connection) => total + connection.socket.disconnects,
      0,
    );
  }

  readonly open = (): Pick<Manager, 'socket'> => {
    const connection = new FakeConnection();
    this.opened.push(connection);
    return {
      socket: connection.create.bind(connection),
    } as unknown as Pick<Manager, 'socket'>;
  };
}

class FakeTarget implements ThreadEventTarget {
  readonly updates: ThreadUpdate[] = [];
  private destroyed = false;
  private readonly listeners = new Set<() => void>();

  once(_event: 'destroyed', listener: () => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'destroyed', listener: () => void): void {
    this.listeners.delete(listener);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, update: ThreadUpdate): void {
    assert.equal(channel, threadUpdateChannel);
    this.updates.push(update);
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }
}

const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const setup = () => {
  const connections = new FakeConnections();
  const directory = mkdtempSync(join(tmpdir(), 'doric-thread-events-'));
  directories.push(directory);
  const history = createThreadHistoryStore(directory);
  const service = createThreadEventService(connections.open, history);
  const target = new FakeTarget();
  return { connections, service, target, history, directory };
};

const event = (sequence: number, threadId = 'thread-id') => ({
  projectId: 'project-id',
  threadId,
  promptId: 'prompt-id',
  sequence,
  type: 'message.delta',
  event: { text: String(sequence) },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const thread = (id: string) => ({
  id,
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** The Thread an update names, as the subscription promises it does. */
const namedThread = (update: ThreadUpdate): string => {
  switch (update.kind) {
    case 'snapshot':
      return update.snapshot.threadId;
    case 'event':
      return update.event.threadId;
    case 'updated':
      return update.thread.id;
    case 'deleted':
      return update.threadId;
    case 'error':
      return update.threadId;
  }
};

describe('Thread event subscription', () => {
  test('forwards replay before live events without changing their order', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'thread-id', 2);
    const { socket } = connections.latest;

    socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(3), event(4)],
    });
    socket.emit('agent:event', event(5));

    assert.equal(connections.latest.namespace, '/threads');
    assert.deepEqual(
      target.updates.map((update) =>
        update.kind === 'event' ? update.event.sequence : update.kind,
      ),
      ['snapshot', 5],
    );
  });

  test('advances reconnect auth to the last delivered durable sequence', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'thread-id', 7);
    const { socket } = connections.latest;

    socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(8), event(9)],
    });
    socket.emit('agent:event', event(10));

    assert.deepEqual(socket.auth, {
      threadId: 'thread-id',
      afterSequence: 10,
    });
  });

  test("drops a foreign event carried inside this Thread's snapshot", () => {
    const { connections, service, target, history } = setup();
    service.watch(target, 'thread-id', 0);
    const { socket } = connections.latest;

    socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(3), event(9, 'other-thread'), event(4)],
    });

    const [update] = target.updates;
    assert.ok(update !== undefined && update.kind === 'snapshot');
    assert.deepEqual(
      update.snapshot.events.map((entry) => entry.sequence),
      [3, 4],
    );
    // A foreign event must not move the reconnect cursor past events this
    // Thread really holds.
    assert.deepEqual(socket.auth, { threadId: 'thread-id', afterSequence: 4 });
    assert.deepEqual(
      history.read('thread-id')?.events.map((entry) => entry.sequence),
      [3, 4],
    );
    assert.equal(history.read('other-thread'), null);
  });

  test('replaces a Thread watch with its own new connection', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'thread-id', 0);
    const first = connections.opened[0];

    service.watch(target, 'thread-id', 4);

    assert.equal(connections.opened.length, 2);
    assert.equal(first.socket.disconnects, 1);
    assert.deepEqual(connections.latest.socket.auth, {
      threadId: 'thread-id',
      afterSequence: 4,
    });

    connections.latest.socket.emit('agent:event', event(5));
    first.socket.emit('agent:event', event(6));
    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['event'],
    );
  });

  test('watches two Threads at once, each on its own connection', () => {
    const { connections, service, target } = setup();
    const other = new FakeTarget();
    service.watch(target, 'first-thread', 0);
    service.watch(other, 'second-thread', 2);
    const [first, second] = connections.opened;

    // Two watches, two connections, each one connected on its own.
    assert.deepEqual(
      connections.opened.map((connection) => connection.socket.connects),
      [1, 1],
    );

    first.socket.emit('thread:snapshot', {
      threadId: 'first-thread',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(1, 'first-thread')],
    });
    second.socket.emit('thread:snapshot', {
      threadId: 'second-thread',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(3, 'second-thread')],
    });
    first.socket.emit('agent:event', event(2, 'first-thread'));
    second.socket.emit('agent:event', event(4, 'second-thread'));
    first.socket.emit('thread:updated', thread('first-thread'));
    second.socket.emit('thread:updated', thread('second-thread'));
    second.socket.emit('thread:deleted', {
      projectId: 'project-id',
      threadId: 'second-thread',
    });

    assert.deepEqual(target.updates.map(namedThread), [
      'first-thread',
      'first-thread',
      'first-thread',
    ]);
    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['snapshot', 'event', 'updated'],
    );
    assert.deepEqual(other.updates.map(namedThread), [
      'second-thread',
      'second-thread',
      'second-thread',
      'second-thread',
    ]);
    assert.deepEqual(
      other.updates.map((update) => update.kind),
      ['snapshot', 'event', 'updated', 'deleted'],
    );
  });

  test('drops a snapshot, an event or a notice of another Thread', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'thread-id', 0);
    const { socket } = connections.latest;

    socket.emit('thread:snapshot', {
      threadId: 'other-thread',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(9, 'other-thread')],
    });
    socket.emit('agent:event', event(10, 'other-thread'));
    socket.emit('thread:updated', thread('other-thread'));
    socket.emit('thread:deleted', {
      projectId: 'project-id',
      threadId: 'other-thread',
    });

    assert.deepEqual(target.updates, []);
    // A foreign snapshot also leaves this watch's cursor where it was.
    assert.deepEqual(socket.auth, {
      threadId: 'thread-id',
      afterSequence: 0,
    });
  });

  test('stops only the Thread it is asked for', () => {
    const { connections, service, target } = setup();
    const other = new FakeTarget();
    service.watch(target, 'first-thread', 0);
    service.watch(other, 'second-thread', 0);
    const [first, second] = connections.opened;

    // A window that does not watch this Thread cannot end its watch.
    service.stop(other, 'first-thread');
    assert.equal(first.socket.disconnects, 0);

    service.stop(target, 'first-thread');
    service.stop(target, 'first-thread');

    assert.equal(first.socket.disconnects, 1);
    assert.equal(first.socket.connected, false);
    assert.equal(second.socket.disconnects, 0);
    assert.equal(second.socket.connected, true);

    first.socket.emit('agent:event', event(1, 'first-thread'));
    second.socket.emit('agent:event', event(2, 'second-thread'));
    assert.deepEqual(target.updates, []);
    assert.deepEqual(other.updates.map(namedThread), ['second-thread']);
  });

  test('ends every watch a window holds when it is destroyed', () => {
    const { connections, service, target } = setup();
    const other = new FakeTarget();
    service.watch(target, 'first-thread', 0);
    service.watch(target, 'second-thread', 0);
    service.watch(other, 'third-thread', 0);
    const [first, second, third] = connections.opened;

    target.destroy();

    assert.equal(first.socket.disconnects, 1);
    assert.equal(second.socket.disconnects, 1);
    assert.equal(third.socket.disconnects, 0);
    first.socket.emit('agent:event', event(1, 'first-thread'));
    second.socket.emit('agent:event', event(2, 'second-thread'));
    assert.deepEqual(target.updates, []);

    third.socket.emit('agent:event', event(3, 'third-thread'));
    assert.deepEqual(other.updates.map(namedThread), ['third-thread']);
  });

  test('closes every open subscription during app shutdown', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'first-thread', 0);
    service.watch(target, 'second-thread', 0);

    service.close();
    service.close();

    assert.equal(connections.disconnects, 2);
  });

  test('forwards only a sanitized workspace error message', () => {
    const { connections, service, target } = setup();
    service.watch(target, 'thread-id', 0);
    const { socket } = connections.latest;

    socket.emit('workspace:error', {
      code: 'replay_failed',
      message: 'The snapshot could not be loaded.',
      secret: 'hidden',
    });

    assert.deepEqual(target.updates, [
      {
        kind: 'error',
        threadId: 'thread-id',
        message: 'The snapshot could not be loaded.',
      },
    ]);

    socket.emit('workspace:error', { message: 'internal detail' });
    assert.deepEqual(target.updates[1], {
      kind: 'error',
      threadId: 'thread-id',
      message: 'The Thread event stream failed.',
    });
  });

  test('persists every forwarded update into the Thread history snapshot', () => {
    const { connections, service, target, history } = setup();
    service.watch(target, 'thread-id', 0);
    const { socket } = connections.latest;

    socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(1), event(2)],
    });
    socket.emit('agent:event', event(3));
    socket.emit('thread:updated', {
      id: 'thread-id',
      name: 'Renamed',
      projectId: 'project-id',
      state: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const cached = history.read('thread-id');
    assert.deepEqual(
      cached?.events.map((item) => item.sequence),
      [1, 2, 3],
    );
    assert.equal(cached?.thread?.name, 'Renamed');

    socket.emit('thread:deleted', {
      projectId: 'project-id',
      threadId: 'thread-id',
    });
    assert.equal(history.read('thread-id'), null);
  });

  test('writes the cached snapshot before the subscription closes', () => {
    const { connections, service, target, directory } = setup();
    service.watch(target, 'thread-id', 0);

    connections.latest.socket.emit('agent:event', event(1));
    service.close();

    assert.deepEqual(
      createThreadHistoryStore(directory)
        .read('thread-id')
        ?.events.map((item) => item.sequence),
      [1],
    );
  });
});
