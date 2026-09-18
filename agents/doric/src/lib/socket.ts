import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

import type { SessionPublisher } from './session-publisher.js';
import type { Session, SessionEvent, SessionStore } from './sessions.js';

const queryInput = z.object({
  sessionId: z.uuid(),
  afterSequence: z.coerce.number().int().safe().nonnegative().optional(),
});

type Subscription = {
  ready: boolean;
  lastSequence: number;
  readonly buffered: SessionEvent[];
  update?: Session;
  deleted: boolean;
};

/** Attaches query-based durable replay followed by race-free live delivery. */
export const createSessionsSocket = (
  io: Server,
  store: SessionStore,
): SessionPublisher => {
  const namespace = io.of('/sessions');
  const subscriptions = new Map<string, Map<Socket, Subscription>>();

  namespace.use((socket, next) => {
    const parsed = queryInput.safeParse(socket.handshake.query);

    if (!parsed.success) {
      next(new Error('A valid sessionId query parameter is required.'));

      return;
    }

    socket.data.subscription = parsed.data;

    next();
  });

  namespace.on('connection', async (socket) => {
    const { sessionId, afterSequence = 0 } = socket.data
      .subscription as z.output<typeof queryInput>;

    const subscription = subscribe(
      subscriptions,
      sessionId,
      socket,
      afterSequence,
    );

    socket.on('disconnect', () =>
      unsubscribe(subscriptions, sessionId, socket),
    );

    const [record, events] = await Promise.all([
      store.find(sessionId),
      store.eventsAfter(sessionId, afterSequence),
    ]);

    socket.emit('session:snapshot', {
      sessionId,
      session: record?.session ?? null,
      events,
    });

    subscription.lastSequence = Math.max(
      afterSequence,
      events.at(-1)?.sequence ?? afterSequence,
    );

    subscription.ready = true;

    flush(subscriptions, socket, sessionId, subscription);
  });

  return {
    event(value) {
      subscriptions.get(value.sessionId)?.forEach((subscription, socket) => {
        if (!subscription.ready) {
          subscription.buffered.push(value);

          return;
        }

        emitEvent(socket, subscription, value);
      });
    },
    updated(value) {
      subscriptions.get(value.id)?.forEach((subscription, socket) => {
        if (!subscription.ready) {
          subscription.update = value;

          return;
        }

        socket.emit('session:updated', value);
      });
    },
    deleted(id) {
      subscriptions.get(id)?.forEach((subscription, socket) => {
        if (!subscription.ready) {
          subscription.deleted = true;

          return;
        }

        socket.emit('session:deleted', { sessionId: id });

        unsubscribe(subscriptions, id, socket);
      });
    },
  };
};

const subscribe = (
  subscriptions: Map<string, Map<Socket, Subscription>>,
  sessionId: string,
  socket: Socket,
  afterSequence: number,
): Subscription => {
  const sockets =
    subscriptions.get(sessionId) ?? new Map<Socket, Subscription>();

  const subscription = {
    ready: false,
    lastSequence: afterSequence,
    buffered: [],
    deleted: false,
  };

  sockets.set(socket, subscription);

  subscriptions.set(sessionId, sockets);

  return subscription;
};

const unsubscribe = (
  subscriptions: Map<string, Map<Socket, Subscription>>,
  sessionId: string,
  socket: Socket,
) => {
  const sockets = subscriptions.get(sessionId);

  sockets?.delete(socket);

  if (sockets?.size === 0) {
    subscriptions.delete(sessionId);
  }
};

const flush = (
  subscriptions: Map<string, Map<Socket, Subscription>>,
  socket: Socket,
  sessionId: string,
  subscription: Subscription,
) => {
  subscription.buffered
    .sort((left, right) => left.sequence - right.sequence)
    .forEach((event) => emitEvent(socket, subscription, event));

  subscription.buffered.length = 0;

  if (subscription.update !== undefined) {
    socket.emit('session:updated', subscription.update);

    subscription.update = undefined;
  }

  if (subscription.deleted) {
    socket.emit('session:deleted', { sessionId });

    unsubscribe(subscriptions, sessionId, socket);
  }
};

const emitEvent = (
  socket: Socket,
  subscription: Subscription,
  event: SessionEvent,
) => {
  if (event.sequence <= subscription.lastSequence) {
    return;
  }

  socket.emit('agent:event', event);

  subscription.lastSequence = event.sequence;
};
