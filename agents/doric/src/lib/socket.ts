import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

import type {
  ProjectStore,
  ThreadEvent,
  ThreadStore,
  WorkspacePublisher,
} from './workspace.js';

const threadQuery = z.object({
  threadId: z.uuid(),
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});
const projectQuery = z.object({ projectId: z.uuid() });
type Notice = { readonly name: string; readonly value: unknown };
type Subscription = {
  ready: boolean;
  lastSequence: number;
  readonly events: Map<number, ThreadEvent>;
  readonly notices: Notice[];
};
type Subscribers = Map<string, Map<Socket, Subscription>>;

/** Subscribe before reading durable data, then deduplicate replay against live events. */
export const createWorkspaceSocket = (
  io: Server,
  projects: ProjectStore,
  threads: ThreadStore,
): WorkspacePublisher => {
  const threadSubscriptions: Subscribers = new Map();
  const projectSubscriptions: Subscribers = new Map();
  const threadNamespace = io.of('/threads');
  const projectNamespace = io.of('/projects');
  threadNamespace.use((socket, next) => {
    const input = threadQuery.safeParse(socket.handshake.query);
    next(input.success ? undefined : new Error('Invalid thread subscription.'));
  });
  projectNamespace.use((socket, next) => {
    const input = projectQuery.safeParse(socket.handshake.query);
    next(
      input.success ? undefined : new Error('Invalid project subscription.'),
    );
  });
  threadNamespace.on('connection', (socket) => {
    const { threadId, afterSequence } = threadQuery.parse(
      socket.handshake.query,
    );
    const subscription = subscribe(
      threadSubscriptions,
      threadId,
      socket,
      afterSequence,
    );
    void replayThread(socket, subscription, threadId, afterSequence);
  });
  projectNamespace.on('connection', (socket) => {
    const { projectId } = projectQuery.parse(socket.handshake.query);
    const subscription = subscribe(projectSubscriptions, projectId, socket, 0);
    void replayProject(socket, subscription, projectId);
  });

  async function replayThread(
    socket: Socket,
    subscription: Subscription,
    threadId: string,
    afterSequence: number,
  ) {
    try {
      const [record, history] = await Promise.all([
        threads.find(threadId),
        threads.eventsAfter(threadId, afterSequence),
      ]);
      const project =
        record === undefined
          ? undefined
          : await projects.find(record.thread.projectId);
      if (!socket.connected) return;
      const events = history
        .filter((event) => event.sequence > afterSequence)
        .sort((a, b) => a.sequence - b.sequence);
      socket.emit('thread:snapshot', {
        threadId,
        projectId: record?.thread.projectId ?? null,
        project: project?.project ?? null,
        thread: record?.thread ?? null,
        events,
      });
      subscription.lastSequence = events.at(-1)?.sequence ?? afterSequence;
      subscription.ready = true;
      flushEvents(socket, subscription);
      flushNotices(socket, subscription);
    } catch {
      fail(socket);
    }
  }
  async function replayProject(
    socket: Socket,
    subscription: Subscription,
    projectId: string,
  ) {
    try {
      const [record, tree] = await Promise.all([
        projects.find(projectId),
        threads.listByProject(projectId),
      ]);
      if (!socket.connected) return;
      socket.emit('project:snapshot', {
        projectId,
        project: record?.project ?? null,
        threads: tree,
      });
      subscription.ready = true;
      flushNotices(socket, subscription);
    } catch {
      fail(socket);
    }
  }
  return {
    event(value) {
      threadSubscriptions
        .get(value.threadId)
        ?.forEach((subscription, socket) => {
          if (value.sequence <= subscription.lastSequence) return;
          subscription.events.set(value.sequence, value);
          if (subscription.ready) flushEvents(socket, subscription);
        });
    },
    threadUpdated(value) {
      notify(threadSubscriptions, value.id, 'thread:updated', value);
      notify(projectSubscriptions, value.projectId, 'thread:updated', value);
    },
    threadDeleted(projectId, threadId) {
      const value = { projectId, threadId };
      notify(threadSubscriptions, threadId, 'thread:deleted', value);
      notify(projectSubscriptions, projectId, 'thread:deleted', value);
    },
    projectUpdated(value) {
      notify(projectSubscriptions, value.id, 'project:updated', value);
    },
    projectDeleted(projectId) {
      notify(projectSubscriptions, projectId, 'project:deleted', { projectId });
    },
  };
};
const subscribe = (
  subscribers: Subscribers,
  id: string,
  socket: Socket,
  sequence: number,
) => {
  const sockets = subscribers.get(id) ?? new Map<Socket, Subscription>();
  const subscription: Subscription = {
    ready: false,
    lastSequence: sequence,
    events: new Map(),
    notices: [],
  };
  sockets.set(socket, subscription);
  subscribers.set(id, sockets);
  socket.on('disconnect', () => {
    sockets.delete(socket);
    if (sockets.size === 0) subscribers.delete(id);
    subscription.events.clear();
    subscription.notices.length = 0;
  });
  return subscription;
};
const notify = (
  subscribers: Subscribers,
  id: string,
  name: string,
  value: unknown,
) => {
  subscribers.get(id)?.forEach((subscription, socket) => {
    if (!subscription.ready) {
      subscription.notices.push({ name, value });
      return;
    }
    socket.emit(name, value);
  });
};
const flushEvents = (socket: Socket, subscription: Subscription) => {
  for (const sequence of subscription.events.keys()) {
    if (sequence <= subscription.lastSequence)
      subscription.events.delete(sequence);
  }
  // A delayed publication must not lose an earlier, durably persisted event.
  for (;;) {
    const event = subscription.events.get(subscription.lastSequence + 1);
    if (event === undefined) return;
    socket.emit('agent:event', event);
    subscription.lastSequence = event.sequence;
    subscription.events.delete(event.sequence);
  }
};
const flushNotices = (socket: Socket, subscription: Subscription) => {
  for (const notice of subscription.notices)
    socket.emit(notice.name, notice.value);
  subscription.notices.length = 0;
};
const fail = (socket: Socket) => {
  if (!socket.connected) return;
  socket.emit('workspace:error', {
    code: 'replay_failed',
    message: 'The snapshot could not be loaded.',
  });
  socket.disconnect();
};
