import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

import type { Session, SessionEvent } from '../src/lib/sessions.js';
import { createSessionsSocket } from '../src/lib/socket.js';

test('plays full history from connection query before live events', async () => {
  const events = [storedEvent(1), storedEvent(2)];

  const store = {
    find: async () => ({ session, snapshot: {}, messages: [] }),
    eventsAfter: async (_id: string, sequence: number) =>
      events.filter((event) => event.sequence > sequence),
  };
  const host = await socketHost(store);

  try {
    const socket = sessionSocket(host.url, { sessionId });
    const snapshot = await next<SessionSnapshot>(socket, 'session:snapshot');

    assert.deepEqual(snapshot, { sessionId, session, events });

    const live = next<SessionEvent>(socket, 'agent:event');
    const third = storedEvent(3);

    events.push(third);

    host.publisher.event(third);

    assert.deepEqual(await live, third);

    socket.close();
  } finally {
    await host.close();
  }
});

test('uses an exclusive cursor and avoids replay/live race duplicates', async () => {
  const events = [storedEvent(1), storedEvent(2)];
  let releaseReplay: () => void = () => undefined;

  const replayGate = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });

  const store = {
    find: async () => ({ session, snapshot: {}, messages: [] }),
    eventsAfter: async (_id: string, sequence: number) => {
      await replayGate;

      return events.filter((event) => event.sequence > sequence);
    },
  };
  const host = await socketHost(store);

  try {
    const socket = sessionSocket(host.url, { sessionId, afterSequence: 1 });

    await next(socket, 'connect');

    const unexpected: SessionEvent[] = [];

    socket.on('agent:event', (event) => unexpected.push(event));

    const snapshot = next<SessionSnapshot>(socket, 'session:snapshot');
    const third = storedEvent(3);

    events.push(third);

    host.publisher.event(third);

    releaseReplay();

    assert.deepEqual((await snapshot).events, [events[1], third]);

    const synchronized = next(socket, 'session:updated');

    host.publisher.updated(session);

    await synchronized;

    assert.deepEqual(unexpected, []);

    socket.close();
  } finally {
    await host.close();
  }
});

test('emits live session updates after the snapshot', async () => {
  const host = await socketHost({
    find: async () => ({ session, snapshot: {}, messages: [] }),
    eventsAfter: async () => [],
  });

  try {
    const socket = sessionSocket(host.url, { sessionId });

    await next(socket, 'session:snapshot');

    const updated = { ...session, state: 'running' as const };
    const update = next(socket, 'session:updated');

    host.publisher.updated(updated);

    assert.deepEqual(await update, updated);

    socket.close();
  } finally {
    await host.close();
  }
});

test('emits session deletion after the snapshot', async () => {
  const host = await socketHost({
    find: async () => ({ session, snapshot: {}, messages: [] }),
    eventsAfter: async () => [],
  });

  try {
    const socket = sessionSocket(host.url, { sessionId });

    await next(socket, 'session:snapshot');

    const deletion = next(socket, 'session:deleted');

    host.publisher.deleted(sessionId);

    assert.deepEqual(await deletion, { sessionId });

    socket.close();
  } finally {
    await host.close();
  }
});

test('buffers session updates and deletion published during replay', async () => {
  let releaseReplay: () => void = () => undefined;

  const replayGate = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });

  const host = await socketHost({
    find: async () => ({ session, snapshot: {}, messages: [] }),
    eventsAfter: async () => {
      await replayGate;

      return [];
    },
  });

  try {
    const socket = sessionSocket(host.url, { sessionId });

    await next(socket, 'connect');

    const order: string[] = [];

    socket.on('session:snapshot', () => order.push('session:snapshot'));

    socket.on('session:updated', () => order.push('session:updated'));

    socket.on('session:deleted', () => order.push('session:deleted'));

    const snapshot = next<SessionSnapshot>(socket, 'session:snapshot');
    const update = next<Session>(socket, 'session:updated');
    const deletion = next<{ sessionId: string }>(socket, 'session:deleted');
    const updated = { ...session, state: 'running' as const };

    host.publisher.updated(updated);

    host.publisher.deleted(sessionId);

    releaseReplay();

    assert.deepEqual(await snapshot, { sessionId, session, events: [] });

    assert.deepEqual(await update, updated);

    assert.deepEqual(await deletion, { sessionId });

    assert.deepEqual(order, [
      'session:snapshot',
      'session:updated',
      'session:deleted',
    ]);

    socket.close();
  } finally {
    await host.close();
  }
});

test('rejects connections without a valid sessionId query', async () => {
  const host = await socketHost({
    find: async () => undefined,
    eventsAfter: async () => [],
  });

  try {
    const socket = sessionSocket(host.url);

    await next<Error>(socket, 'connect_error');

    assert.equal(socket.connected, false);

    socket.close();
  } finally {
    await host.close();
  }
});

const sessionId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

const session: Session = {
  id: sessionId,
  state: 'ready',
  configRevision: 1,
  lastSequence: 2,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

type SessionSnapshot = {
  readonly sessionId: string;
  readonly session: Session;
  readonly events: readonly SessionEvent[];
};

const storedEvent = (sequence: number): SessionEvent => ({
  sessionId,
  promptId,
  sequence,
  type: 'reasoning.delta',
  event: { type: 'reasoning.delta', delta: `part-${sequence}` },
  createdAt: new Date(sequence * 1000).toISOString(),
});

const socketHost = async (store: unknown) => {
  const server = createServer();
  const io = new SocketServer(server);
  const publisher = createSessionsSocket(io, store as never);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}/sessions`,
    publisher,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
};

const sessionSocket = (
  url: string,
  query?: Readonly<Record<string, string | number>>,
): Socket =>
  connect(url, {
    transports: ['websocket'],
    reconnection: false,
    ...(query === undefined ? {} : { query }),
  });

const next = <Value = unknown>(socket: Socket, event: string): Promise<Value> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, receive);

      reject(new Error(`Timed out waiting for ${event}.`));
    }, 1_000);

    const receive = (value: Value) => {
      clearTimeout(timeout);

      resolve(value);
    };

    socket.once(event, receive);
  });
