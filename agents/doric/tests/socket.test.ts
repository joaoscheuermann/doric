import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { Server as SocketServer } from 'socket.io';

import { createWorkspaceSocket } from '../src/lib/events/socket.js';
import { defaultConfig } from '../src/lib/config/schema.js';
import type {
  Project,
  Thread,
  ThreadEvent,
  ProjectStore,
  ThreadStore,
} from '../src/lib/workspace/types.js';

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
const project: Project = {
  id: projectId,
  name: 'Project',
  state: 'ready',
  configRevision: 1,
  createdAt: '',
  updatedAt: '',
};
const thread: Thread = {
  id: threadId,
  projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 2,
  createdAt: '',
  updatedAt: '',
};
const event = (sequence: number): ThreadEvent => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: 'text.delta',
  event: { type: 'text.delta', delta: `part-${sequence}` },
  createdAt: '',
});

test('replays ordered durable history then delivers project-scoped live events', async (t) => {
  const host = await serve();
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  t.after(() => socket.close());
  const snapshot = await next<{ project: Project; events: ThreadEvent[] }>(
    socket,
    'thread:snapshot',
  );
  assert.equal(snapshot.project.id, projectId);
  assert.deepEqual(
    snapshot.events.map((value) => value.sequence),
    [1, 2],
  );
  const live = next<ThreadEvent>(socket, 'agent:event');
  host.publisher.event(event(3));
  assert.deepEqual(await live, event(3));
});

test('deduplicates exclusive replay and buffers out-of-order live publications', async (t) => {
  const gate = deferred<readonly ThreadEvent[]>();
  const host = await serve({ eventsAfter: () => gate.promise });
  t.after(host.close);
  const socket = host.connect('/threads', { threadId, afterSequence: 1 });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const received: number[] = [];
  socket.on('agent:event', (value: ThreadEvent) =>
    received.push(value.sequence),
  );
  const snapshot = next<{ events: ThreadEvent[] }>(socket, 'thread:snapshot');
  host.publisher.event(event(3));
  host.publisher.event(event(5));
  host.publisher.event(event(4));
  gate.resolve([event(2), event(3)]);
  assert.deepEqual(
    (await snapshot).events.map((value) => value.sequence),
    [2, 3],
  );
  const barrier = next(socket, 'thread:updated');
  host.publisher.threadUpdated(thread);
  await barrier;
  assert.deepEqual(received, [4, 5]);
});

test('buffers thread lifecycle notifications until replay is visible', async (t) => {
  const gate = deferred<readonly ThreadEvent[]>();
  const host = await serve({ eventsAfter: () => gate.promise });
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const order: string[] = [];
  socket.onAny((name) => order.push(name));
  const deleted = next(socket, 'thread:deleted');
  host.publisher.threadUpdated({ ...thread, state: 'cancelled' });
  host.publisher.threadDeleted(projectId, threadId);
  gate.resolve([]);
  assert.deepEqual(await deleted, { projectId, threadId });
  assert.deepEqual(order, [
    'thread:snapshot',
    'thread:updated',
    'thread:deleted',
  ]);
});

test('snapshots the complete project tree and buffers its updates', async (t) => {
  const gate = deferred<readonly Thread[]>();
  const host = await serve({ listByProject: () => gate.promise });
  t.after(host.close);
  const socket = host.connect('/projects', { projectId });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const child = { ...thread, id: promptId, parentThreadId: threadId };
  const order: string[] = [];
  socket.onAny((name) => order.push(name));
  const snapshot = next<{ threads: Thread[]; project: Project }>(
    socket,
    'project:snapshot',
  );
  const updated = next<Thread>(socket, 'thread:updated');
  const deleted = next(socket, 'project:deleted');
  host.publisher.threadUpdated(child);
  host.publisher.projectDeleted(projectId);
  gate.resolve([thread]);
  assert.deepEqual((await snapshot).threads, [thread]);
  assert.equal((await updated).parentThreadId, threadId);
  assert.deepEqual(await deleted, { projectId });
  assert.deepEqual(order, [
    'project:snapshot',
    'thread:updated',
    'project:deleted',
  ]);
});

test('resnapshots a disconnected client without leaking its buffered notifications', async (t) => {
  const gate = deferred<readonly ThreadEvent[]>();
  const started = deferred<void>();
  const settled = deferred<void>();
  let replay = 0;
  const host = await serve({
    eventsAfter: async () => {
      if (++replay !== 1) return [event(2)];
      started.resolve();
      const history = await gate.promise;
      settled.resolve();
      return history;
    },
  });
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  await next(socket, 'connect');
  await started.promise;
  const stale: string[] = [];
  socket.onAny((name) => stale.push(name));
  host.publisher.threadUpdated({ ...thread, state: 'cancelled' });
  host.publisher.event(event(2));
  const disconnected = new Promise<void>((resolve) =>
    host.io
      .of('/threads')
      .sockets.forEach((serverSocket) =>
        serverSocket.once('disconnect', () => resolve()),
      ),
  );
  socket.close();
  await disconnected;
  gate.resolve([event(1)]);
  await settled.promise;
  const reconnected = host.connect('/threads', { threadId, afterSequence: 1 });
  t.after(() => reconnected.close());
  const deliveries: string[] = [];
  reconnected.onAny((name, value) =>
    deliveries.push(name === 'agent:event' ? `event:${value.sequence}` : name),
  );
  const snapshot = await next<{ events: ThreadEvent[] }>(
    reconnected,
    'thread:snapshot',
  );
  assert.deepEqual(
    snapshot.events.map((value) => value.sequence),
    [2],
  );
  host.publisher.event(event(2));
  host.publisher.event(event(3));
  const barrier = next(reconnected, 'thread:updated');
  host.publisher.threadUpdated(thread);
  await barrier;
  assert.deepEqual(deliveries, [
    'thread:snapshot',
    'event:3',
    'thread:updated',
  ]);
  assert.deepEqual(stale, []);
});

test('sanitizes failed replay and disconnects instead of leaving a partial subscription', async (t) => {
  const host = await serve({
    eventsAfter: async () => {
      throw new Error('secret');
    },
  });
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  t.after(() => socket.close());
  const failure = next<{ code: string; message: string }>(
    socket,
    'workspace:error',
  );
  const disconnected = next(socket, 'disconnect');
  const error = await failure;
  assert.equal(error.code, 'replay_failed');
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.doesNotMatch(JSON.stringify(error), /secret/);
  await disconnected;
  assert.equal(socket.connected, false);
});

test('handles a durable replay rejection after the subscriber disconnects', async (t) => {
  const gate = deferred<readonly ThreadEvent[]>();
  let replay = 0;
  const host = await serve({
    eventsAfter: () => (++replay === 1 ? gate.promise : Promise.resolve([])),
  });
  t.after(host.close);
  const first = host.connect('/threads', { threadId });
  await next(first, 'connect');
  const disconnected = new Promise<void>((resolve) => {
    host.io.of('/threads').sockets.forEach((socket) => {
      socket.once('disconnect', () => resolve());
    });
  });
  first.close();
  await disconnected;
  gate.reject(new Error('private database error'));
  const second = host.connect('/threads', { threadId });
  t.after(() => second.close());
  const snapshot = await next<{ thread: Thread }>(second, 'thread:snapshot');
  assert.equal(snapshot.thread.id, threadId);
});

test('rejects invalid subscriptions and does not expose the removed namespace', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [namespace, query] of [
    ['/threads', {}],
    ['/threads', { threadId, afterSequence: -1 }],
    ['/projects', { projectId: 'bad' }],
    ['/sessions', { sessionId: threadId }],
  ] as const) {
    const socket = host.connect(namespace, query);
    await next(socket, 'connect_error');
    assert.equal(socket.connected, false);
    socket.close();
  }
});

test('routes live notifications only to the subscribed Thread and Project', async (t) => {
  const host = await serve({
    find: async (id) => ({ thread: { ...thread, id }, messages: [] }),
  });
  t.after(host.close);
  for (const [namespace, key, name, publish] of [
    [
      '/threads',
      'threadId',
      'thread:updated',
      (id: string) => host.publisher.threadUpdated({ ...thread, id }),
    ],
    [
      '/projects',
      'projectId',
      'project:updated',
      (id: string) => host.publisher.projectUpdated({ ...project, id }),
    ],
  ] as const) {
    const first = host.connect(namespace, { [key]: threadId });
    const second = host.connect(namespace, { [key]: promptId });
    t.after(() => {
      first.close();
      second.close();
    });
    await Promise.all([
      next(
        first,
        namespace === '/threads' ? 'thread:snapshot' : 'project:snapshot',
      ),
      next(
        second,
        namespace === '/threads' ? 'thread:snapshot' : 'project:snapshot',
      ),
    ]);
    const firstIds: string[] = [];
    const secondIds: string[] = [];
    first.on(name, (value: { id: string }) => firstIds.push(value.id));
    second.on(name, (value: { id: string }) => secondIds.push(value.id));
    publish(threadId);
    publish(promptId);
    // Deletions provide wire-order barriers for the preceding updates.
    const finalBarriers = [
      next(
        first,
        namespace === '/threads' ? 'thread:deleted' : 'project:deleted',
      ),
      next(
        second,
        namespace === '/threads' ? 'thread:deleted' : 'project:deleted',
      ),
    ];
    if (namespace === '/threads') {
      host.publisher.threadDeleted(projectId, threadId);
      host.publisher.threadDeleted(projectId, promptId);
    } else {
      host.publisher.projectDeleted(threadId);
      host.publisher.projectDeleted(promptId);
    }
    await Promise.all(finalBarriers);
    assert.deepEqual(firstIds, [threadId]);
    assert.deepEqual(secondIds, [promptId]);
  }
});

const serve = async (overrides: Partial<ThreadStore> = {}) => {
  const server = createServer();
  const io = new SocketServer(server);
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected write during observation.');
  };
  const projects: ProjectStore = {
    find: async () => ({
      project,
      snapshot: { configuration: defaultConfig, revision: 1, updatedAt: '' },
    }),
    create: unsupported,
    list: async () => ({ items: [project] }),
    rename: unsupported,
    setState: unsupported,
    delete: unsupported,
    reconcile: unsupported,
  };
  const threads: ThreadStore = {
    find: async () => ({ thread, messages: [] }),
    eventsAfter: async (_id: string, cursor: number) =>
      [event(1), event(2)].filter((value) => value.sequence > cursor),
    listByProject: async () => [thread],
    list: async () => ({ items: [thread] }),
    create: unsupported,
    rename: unsupported,
    setState: unsupported,
    saveMessages: unsupported,
    appendEvent: unsupported,
    deleteSubtree: unsupported,
    reconcile: unsupported,
    ...overrides,
  };
  const publisher = createWorkspaceSocket(io, projects, threads);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    io,
    publisher,
    connect: (
      namespace: string,
      query: Readonly<Record<string, string | number>>,
    ) =>
      connect(`http://127.0.0.1:${address.port}${namespace}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        query,
      }),
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const next = <T = unknown>(socket: Socket, name: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, receive);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 2000);
    const receive = (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    };
    socket.once(name, receive);
  });
