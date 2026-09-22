import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Manager, Socket } from 'socket.io-client';

import {
  createThreadEventService,
  type ThreadEventTarget,
  type ThreadUpdate,
  threadUpdateChannel,
} from '../src/workspace/events';

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

class FakeManager {
  readonly socket = new FakeSocket();

  namespace = '';
  options: unknown;

  create(namespace: string, options: unknown): Socket {
    this.namespace = namespace;
    this.options = options;
    return this.socket as unknown as Socket;
  }
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

const setup = () => {
  const manager = new FakeManager();
  const service = createThreadEventService({
    socket: manager.create.bind(manager),
  } as unknown as Pick<Manager, 'socket'>);
  const target = new FakeTarget();
  return { manager, service, target };
};

const event = (sequence: number) => ({
  projectId: 'project-id',
  threadId: 'thread-id',
  promptId: 'prompt-id',
  sequence,
  type: 'message.delta',
  event: { text: String(sequence) },
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('Thread event subscription', () => {
  test('forwards replay before live events without changing their order', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'thread-id', 2);

    manager.socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(3), event(4)],
    });
    manager.socket.emit('agent:event', event(5));

    assert.equal(manager.namespace, '/threads');
    assert.deepEqual(
      target.updates.map((update) =>
        update.kind === 'event' ? update.event.sequence : update.kind,
      ),
      ['snapshot', 5],
    );
  });

  test('advances reconnect auth to the last delivered durable sequence', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'thread-id', 7);

    manager.socket.emit('thread:snapshot', {
      threadId: 'thread-id',
      projectId: 'project-id',
      project: null,
      thread: null,
      events: [event(8), event(9)],
    });
    manager.socket.emit('agent:event', event(10));

    assert.deepEqual(manager.socket.auth, {
      threadId: 'thread-id',
      afterSequence: 10,
    });
  });

  test('switches the selected Thread and stops on renderer destruction', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'first-thread', 0);
    service.watch(target, 'second-thread', 4);

    assert.equal(manager.socket.disconnects, 1);
    assert.deepEqual(manager.socket.auth, {
      threadId: 'second-thread',
      afterSequence: 4,
    });

    target.destroy();
    assert.equal(manager.socket.disconnects, 2);
    manager.socket.emit('agent:event', event(5));
    assert.deepEqual(target.updates, []);
  });

  test('closes the selected subscription during app shutdown', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'thread-id', 0);

    service.close();
    service.close();

    assert.equal(manager.socket.disconnects, 1);
  });

  test('forwards only a sanitized workspace error message', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'thread-id', 0);

    manager.socket.emit('workspace:error', {
      code: 'replay_failed',
      message: 'The snapshot could not be loaded.',
      secret: 'hidden',
    });

    assert.deepEqual(target.updates, [
      {
        kind: 'error',
        message: 'The snapshot could not be loaded.',
      },
    ]);

    manager.socket.emit('workspace:error', { message: 'internal detail' });
    assert.deepEqual(target.updates[1], {
      kind: 'error',
      message: 'The Thread event stream failed.',
    });
  });
});
