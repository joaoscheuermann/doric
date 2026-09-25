import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Manager, Socket } from 'socket.io-client';

import type { Project, Thread } from '../src/workspace/api';
import {
  createProjectEventService,
  type ProjectEventTarget,
  type ProjectUpdate,
  projectUpdateChannel,
} from '../src/workspace/project-events';

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

class FakeTarget implements ProjectEventTarget {
  readonly updates: ProjectUpdate[] = [];
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

  send(channel: string, update: ProjectUpdate): void {
    assert.equal(channel, projectUpdateChannel);
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
  const service = createProjectEventService({
    socket: manager.create.bind(manager),
  } as unknown as Pick<Manager, 'socket'>);
  const target = new FakeTarget();
  return { manager, service, target };
};

const project: Project = {
  id: 'project-id',
  name: 'Project',
  state: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const thread: Thread = {
  id: 'thread-id',
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Project event subscription', () => {
  test('forwards the Project snapshot before live Thread updates', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('project:snapshot', {
      projectId: 'project-id',
      project,
      threads: [thread],
    });
    manager.socket.emit('thread:updated', { ...thread, name: 'Child' });

    assert.equal(manager.namespace, '/projects');
    assert.deepEqual(manager.options, { auth: { projectId: 'project-id' } });
    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['snapshot', 'thread-updated'],
    );
  });

  test('forwards an agent-created Thread notice for the selected Project', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('thread:updated', thread);

    assert.deepEqual(target.updates, [{ kind: 'thread-updated', thread }]);
  });

  test('forwards Thread and Project lifecycle notices', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('thread:deleted', {
      projectId: 'project-id',
      threadId: 'thread-id',
    });
    manager.socket.emit('project:updated', { ...project, name: 'Renamed' });
    manager.socket.emit('project:deleted', { projectId: 'project-id' });

    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['thread-deleted', 'project-updated', 'project-deleted'],
    );
    assert.deepEqual(target.updates[0], {
      kind: 'thread-deleted',
      projectId: 'project-id',
      threadId: 'thread-id',
    });
  });

  test('forwards a fresh snapshot on every reconnect', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('project:snapshot', {
      projectId: 'project-id',
      project,
      threads: [thread],
    });
    manager.socket.disconnect();
    manager.socket.connect();
    manager.socket.emit('project:snapshot', {
      projectId: 'project-id',
      project,
      threads: [thread, { ...thread, id: 'child' }],
    });

    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['snapshot', 'snapshot'],
    );
  });

  test('switches the watched Project and stops on renderer destruction', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'first-project');
    service.watch(target, 'second-project');

    assert.equal(manager.socket.disconnects, 1);
    assert.deepEqual(manager.socket.auth, { projectId: 'second-project' });

    target.destroy();
    assert.equal(manager.socket.disconnects, 2);
    manager.socket.emit('thread:updated', thread);
    assert.deepEqual(target.updates, []);
  });

  test('keeps the selected Project when another target stops', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    service.stop(new FakeTarget());

    assert.equal(manager.socket.disconnects, 0);
    manager.socket.emit('thread:updated', thread);
    assert.deepEqual(
      target.updates.map((update) => update.kind),
      ['thread-updated'],
    );
  });

  test('closes the selected subscription during app shutdown', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    service.close();
    service.close();

    assert.equal(manager.socket.disconnects, 1);
  });

  test('forwards only a fixed message for a workspace error', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('workspace:error', {
      code: 'replay_failed',
      message: 'The snapshot could not be loaded.',
      secret: 'hidden',
    });

    assert.deepEqual(target.updates, [
      { kind: 'error', message: 'The Project event stream failed.' },
    ]);
  });

  test('reports an invalid snapshot with the fixed error message', () => {
    const { manager, service, target } = setup();
    service.watch(target, 'project-id');

    manager.socket.emit('project:snapshot', { projectId: 'project-id' });

    assert.deepEqual(target.updates, [
      { kind: 'error', message: 'The Project event stream failed.' },
    ]);
  });
});
