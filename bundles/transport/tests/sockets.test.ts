import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Project,
  RuntimeListener,
  RuntimeNotice,
  Thread,
  ThreadEvent,
} from 'runtime/contracts';
import { io as connect, Manager, type Socket } from 'socket.io-client';
import type {
  TerminalSession as Terminal,
  TerminalWatchItem,
} from 'terminal/contracts';

import { type Fake, serve as serveHost } from './support/host.js';

/*
 * agents/doric's socket suite, run against the transport bundle: the
 * snapshots read runtime contracts and the live notices arrive through
 * `runtime/v1.watch`, the terminal ones through `terminal/v1.watchProject`
 * (stage 10 §4). Across processes a notice and a snapshot read's answer
 * travel on the same ordered envelope link (host-stages-crossreview.md §3),
 * and the algorithm tolerates either order anyway: it subscribes before it
 * reads, buffers, then deduplicates; these cases drive both orders.
 */

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
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
};
const terminal: Terminal = {
  id: 'terminal-1',
  projectId,
  threadId,
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: '',
  timeoutMs: null,
  state: 'running',
  pty: true,
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

interface Reads {
  readonly eventsAfter?: (
    threadId: string,
    afterSequence: number,
  ) => Promise<readonly ThreadEvent[]>;
  readonly projectThreads?: () => Promise<readonly Thread[]>;
  readonly terminals?: () => readonly Terminal[];
}

/** The transport over a runtime whose notices a case publishes. */
const serve = async (reads: Reads = {}, runtime: Fake = {}) => {
  const listeners: RuntimeListener[] = [];
  const disposed: RuntimeListener[] = [];
  type Watch = { projectId: string; listener: unknown; open: boolean };
  const watches: Watch[] = [];
  const host = await serveHost({
    runtime: {
      project: async () => project,
      watch: (listener: RuntimeListener) => {
        listeners.push(listener);
        return { dispose: () => disposed.push(listener) };
      },
      ...runtime,
    },
    threads: {
      storedThread: async () => thread,
      storedEventsAfter: ({
        id,
        afterSequence,
      }: {
        id: string;
        afterSequence: number;
      }) =>
        reads.eventsAfter?.(id, afterSequence) ??
        [event(1), event(2)].filter((value) => value.sequence > afterSequence),
      projectThreads: () => reads.projectThreads?.() ?? [thread],
    },
    terminal: {
      list: () => reads.terminals?.() ?? [],
      watchProject: (id: string, listener: unknown) => {
        const watch: Watch = { projectId: id, listener, open: true };
        watches.push(watch);
        return {
          dispose: () => {
            watch.open = false;
          },
        };
      },
    },
  });
  const publish = (notice: RuntimeNotice) => {
    for (const listener of listeners) listener(notice);
  };
  const emit = (item: TerminalWatchItem) => {
    const target =
      item.kind === 'updated'
        ? item.terminal.projectId
        : item.kind === 'output'
          ? item.output.projectId
          : item.projectId;
    for (const watch of watches) {
      if (!watch.open || watch.projectId !== target) continue;
      const { listener } = watch;
      if (typeof listener === 'function') listener(item);
      else (listener as { next(item: unknown): void }).next(item);
    }
  };
  return {
    ...host,
    listeners,
    disposed,
    watches,
    publisher: {
      event: (value: ThreadEvent) => publish({ kind: 'event', value }),
      threadUpdated: (value: Thread) =>
        publish({ kind: 'threadUpdated', value }),
      threadDeleted: (project: string, thread: string) =>
        publish({
          kind: 'threadDeleted',
          projectId: project,
          threadId: thread,
        }),
      projectUpdated: (value: Project) =>
        publish({ kind: 'projectUpdated', value }),
      projectDeleted: (id: string) =>
        publish({ kind: 'projectDeleted', projectId: id }),
      terminalUpdated: (value: Terminal) =>
        emit({ kind: 'updated', terminal: value }),
      terminalOutput: (data: string, offset: number) =>
        emit({
          kind: 'output',
          output: {
            projectId,
            threadId,
            terminalId: terminal.id,
            data,
            offset,
          },
        }),
      terminalRemoved: () =>
        emit({
          kind: 'removed',
          projectId,
          threadId,
          terminalId: terminal.id,
        }),
    },
  };
};

void test('subscribes to runtime/v1 once on activation and releases it on cleanup', async () => {
  const calls: string[] = [];
  const host = await serve(
    {},
    {
      project: async () => {
        calls.push('project');
        return project;
      },
    },
  );
  // Activation registers routes and namespaces only: no read reached the
  // runtime, and exactly one subscription was taken.
  assert.deepEqual(calls, []);
  assert.equal(host.listeners.length, 1);
  assert.deepEqual(host.disposed, []);
  await host.close();
  assert.deepEqual(host.disposed, host.listeners);
});

void test('accepts a status connection without subscription parameters', async (t) => {
  const host = await serve();
  t.after(host.close);
  const socket = host.connect('/status');
  t.after(() => socket.close());
  await next(socket, 'connect');
  assert.equal(socket.connected, true);
});

void test('multiplexes status and workspace namespaces over one Engine.IO connection', async (t) => {
  const host = await serve();
  t.after(host.close);
  const manager = new Manager(host.url, {
    transports: ['websocket'],
    reconnection: false,
  });
  const status = manager.socket('/status');
  const workspace = manager.socket('/threads', { auth: { threadId } });
  t.after(() => {
    status.close();
    workspace.close();
  });
  await Promise.all([
    next(status, 'connect'),
    next(workspace, 'thread:snapshot'),
  ]);
  assert.equal(host.engineConnections(), 1);
});

void test('replays ordered durable history then delivers project-scoped live events', async (t) => {
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

void test('emits the fixed thread snapshot payload on subscription', async (t) => {
  const host = await serve();
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  t.after(() => socket.close());
  const snapshot = await next<Record<string, unknown>>(
    socket,
    'thread:snapshot',
  );
  assert.deepEqual(snapshot, {
    threadId,
    projectId,
    project,
    thread,
    events: [event(1), event(2)],
  });
});

void test('answers a snapshot of an unknown Thread with nulls', async (t) => {
  const missingThread = await serveHost({
    threads: {
      storedThread: async () => undefined,
      storedEventsAfter: async () => [],
    },
  });
  t.after(missingThread.close);
  const socket = missingThread.connect('/threads', { threadId });
  t.after(() => socket.close());
  assert.deepEqual(await next(socket, 'thread:snapshot'), {
    threadId,
    projectId: null,
    project: null,
    thread: null,
    events: [],
  });
});

void test('deduplicates exclusive replay and buffers out-of-order live publications', async (t) => {
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

void test('buffers thread lifecycle notifications until replay is visible', async (t) => {
  const gate = deferred<readonly ThreadEvent[]>();
  const host = await serve({ eventsAfter: () => gate.promise });
  t.after(host.close);
  const socket = host.connect('/threads', { threadId });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const order: string[] = [];
  socket.onAny((name: string) => order.push(name));
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

void test('snapshots the complete project tree and buffers its updates', async (t) => {
  const gate = deferred<readonly Thread[]>();
  const host = await serve({
    projectThreads: () => gate.promise,
    terminals: () => [terminal],
  });
  t.after(host.close);
  const socket = host.connect('/projects', { projectId });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const child = { ...thread, id: promptId, parentThreadId: threadId };
  const order: string[] = [];
  socket.onAny((name: string) => order.push(name));
  const snapshot = next<Record<string, unknown>>(socket, 'project:snapshot');
  const terminals = next(socket, 'terminal:snapshot');
  const updated = next<Thread>(socket, 'thread:updated');
  const deleted = next(socket, 'project:deleted');
  host.publisher.threadUpdated(child);
  host.publisher.projectDeleted(projectId);
  gate.resolve([thread]);
  assert.deepEqual(await snapshot, {
    projectId,
    project,
    threads: [thread],
    terminals: [terminal],
  });
  assert.deepEqual(await terminals, { projectId, terminals: [terminal] });
  assert.equal((await updated).parentThreadId, threadId);
  assert.deepEqual(await deleted, { projectId });
  assert.deepEqual(order, [
    'project:snapshot',
    'terminal:snapshot',
    'thread:updated',
    'project:deleted',
  ]);
});

void test('buffers terminal lifecycle notices but never terminal output', async (t) => {
  const gate = deferred<readonly Thread[]>();
  const host = await serve({ projectThreads: () => gate.promise });
  t.after(host.close);
  const socket = host.connect('/projects', { projectId });
  t.after(() => socket.close());
  await next(socket, 'connect');
  const order: string[] = [];
  socket.onAny((name: string) => order.push(name));
  host.publisher.terminalUpdated(terminal);
  // Output published before the snapshot is dropped: a client reads the
  // bounded terminal snapshot instead.
  host.publisher.terminalOutput('lost', 4);
  host.publisher.terminalRemoved();
  gate.resolve([thread]);
  await next(socket, 'terminal:removed');
  const output = next(socket, 'terminal:output');
  host.publisher.terminalOutput('kept', 8);
  assert.deepEqual(await output, {
    projectId,
    threadId,
    terminalId: terminal.id,
    data: 'kept',
    offset: 8,
  });
  assert.deepEqual(order, [
    'project:snapshot',
    'terminal:snapshot',
    'terminal:updated',
    'terminal:removed',
    'terminal:output',
  ]);
});

void test("watches a Project's terminals while any socket subscribes to it, once", async (t) => {
  const host = await serve();
  t.after(host.close);
  const first = host.connect('/projects', { projectId });
  const second = host.connect('/projects', { projectId });
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([
    next(first, 'terminal:snapshot'),
    next(second, 'terminal:snapshot'),
  ]);
  assert.deepEqual(
    host.watches.map(({ projectId: id, open }) => [id, open]),
    [[projectId, true]],
  );
  // A removal reaches both sockets with the namespace's own shape.
  const removed = next(second, 'terminal:removed');
  host.publisher.terminalRemoved();
  assert.deepEqual(await removed, {
    projectId,
    threadId,
    terminalId: terminal.id,
  });
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.watches[0]?.open, true);
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.watches[0]?.open, false);
});

void test('resnapshots a disconnected client without leaking its buffered notifications', async (t) => {
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
  socket.onAny((name: string) => stale.push(name));
  host.publisher.threadUpdated({ ...thread, state: 'cancelled' });
  host.publisher.event(event(2));
  const disconnected = new Promise<void>((resolve) =>
    host.io.of('/threads').sockets.forEach((serverSocket) => {
      serverSocket.once('disconnect', () => resolve());
    }),
  );
  socket.close();
  await disconnected;
  gate.resolve([event(1)]);
  await settled.promise;
  const reconnected = host.connect('/threads', { threadId, afterSequence: 1 });
  t.after(() => reconnected.close());
  const deliveries: string[] = [];
  reconnected.onAny((name: string, value: ThreadEvent) =>
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

void test('sanitizes failed replay and disconnects instead of leaving a partial subscription', async (t) => {
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
  assert.deepEqual(await failure, {
    code: 'replay_failed',
    message: 'The snapshot could not be loaded.',
  });
  await disconnected;
  assert.equal(socket.connected, false);
});

void test('handles a durable replay rejection after the subscriber disconnects', async (t) => {
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

void test('rejects invalid auth and does not expose the removed namespace', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [namespace, auth, message] of [
    ['/threads', {}, 'Invalid thread subscription.'],
    [
      '/threads',
      { threadId, afterSequence: -1 },
      'Invalid thread subscription.',
    ],
    ['/projects', { projectId: 'bad' }, 'Invalid project subscription.'],
    ['/sessions', { sessionId: threadId }, 'Invalid namespace'],
  ] as const) {
    const socket = host.connect(namespace, auth);
    const error = await next<Error>(socket, 'connect_error');
    assert.equal(error.message, message);
    assert.equal(socket.connected, false);
    socket.close();
  }
});

void test('rejects legacy query-only workspace subscriptions', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [namespace, query] of [
    ['/threads', { threadId }],
    ['/projects', { projectId }],
  ] as const) {
    const socket = connect(`${host.url}${namespace}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      query,
    });
    await next(socket, 'connect_error');
    assert.equal(socket.connected, false);
    socket.close();
  }
});

void test('routes live notifications only to the subscribed Thread and Project', async (t) => {
  const host = await serve();
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
    const snapshotName =
      namespace === '/threads' ? 'thread:snapshot' : 'project:snapshot';
    await Promise.all([next(first, snapshotName), next(second, snapshotName)]);
    const firstIds: string[] = [];
    const secondIds: string[] = [];
    first.on(name, (value: { id: string }) => firstIds.push(value.id));
    second.on(name, (value: { id: string }) => secondIds.push(value.id));
    publish(threadId);
    publish(promptId);
    // Deletions provide wire-order barriers for the preceding updates.
    const deletedName =
      namespace === '/threads' ? 'thread:deleted' : 'project:deleted';
    const finalBarriers = [next(first, deletedName), next(second, deletedName)];
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
