import type {
  Project,
  RuntimeListener,
  Terminal,
  TerminalOutput,
  Thread,
  ThreadEvent,
} from 'runtime/contracts';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

const threadAuth = z.object({
  threadId: z.uuid(),
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});
const projectAuth = z.object({ projectId: z.uuid() });
interface Notice {
  readonly name: string;
  readonly value: unknown;
}
interface Subscription {
  ready: boolean;
  lastSequence: number;
  readonly events: Map<number, ThreadEvent>;
  readonly notices: Notice[];
}
type Subscribers = Map<string, Map<Socket, Subscription>>;

/**
 * The durable reads a snapshot needs (design 57 §8.4). Each one is a contract
 * call; a notice published after a read was answered travels behind that
 * answer on the same ordered link, and the algorithm below tolerates either
 * order anyway: it subscribes first, buffers, then deduplicates.
 */
export interface WorkspaceReads {
  /** `runtime.threads/v1.storedThread`. */
  thread(threadId: string): Promise<Thread | undefined>;
  /** `runtime.threads/v1.storedEventsAfter`. */
  eventsAfter(
    threadId: string,
    afterSequence: number,
  ): Promise<readonly ThreadEvent[]>;
  /** `runtime/v1.project`. */
  project(projectId: string): Promise<Project | undefined>;
  /** `runtime.threads/v1.projectThreads`. */
  projectThreads(projectId: string): Promise<readonly Thread[]>;
  /** `runtime.terminals/v1.list`. */
  terminals(projectId: string): Promise<readonly Terminal[]>;
}

/** Subscribe before reading durable data, then deduplicate replay against live events. */
export const createWorkspaceSocket = (
  io: Server,
  reads: WorkspaceReads,
): RuntimeListener => {
  const threadSubscriptions: Subscribers = new Map();
  const projectSubscriptions: Subscribers = new Map();
  const threadNamespace = io.of('/threads');
  const projectNamespace = io.of('/projects');
  threadNamespace.use((socket, next) => {
    const input = threadAuth.safeParse(socket.handshake.auth);
    next(input.success ? undefined : new Error('Invalid thread subscription.'));
  });
  projectNamespace.use((socket, next) => {
    const input = projectAuth.safeParse(socket.handshake.auth);
    next(
      input.success ? undefined : new Error('Invalid project subscription.'),
    );
  });
  threadNamespace.on('connection', (socket) => {
    const { threadId, afterSequence } = threadAuth.parse(socket.handshake.auth);
    const subscription = subscribe(
      threadSubscriptions,
      threadId,
      socket,
      afterSequence,
    );
    void replayThread(socket, subscription, threadId, afterSequence);
  });
  projectNamespace.on('connection', (socket) => {
    const { projectId } = projectAuth.parse(socket.handshake.auth);
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
        reads.thread(threadId),
        reads.eventsAfter(threadId, afterSequence),
      ]);
      const project =
        record === undefined
          ? undefined
          : await reads.project(record.projectId);
      if (!socket.connected) return;
      const events = history
        .filter((event) => event.sequence > afterSequence)
        .sort((a, b) => a.sequence - b.sequence);
      socket.emit('thread:snapshot', {
        threadId,
        projectId: record?.projectId ?? null,
        project: project ?? null,
        thread: record ?? null,
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
        reads.project(projectId),
        reads.projectThreads(projectId),
      ]);
      // Read once after the tree, where both snapshots read it before.
      const terminals = await reads.terminals(projectId);
      if (!socket.connected) return;
      socket.emit('project:snapshot', {
        projectId,
        project: record ?? null,
        threads: tree,
        terminals,
      });
      socket.emit('terminal:snapshot', { projectId, terminals });
      subscription.ready = true;
      flushNotices(socket, subscription);
    } catch {
      fail(socket);
    }
  }
  const publisher = {
    terminalUpdated(value: Terminal) {
      notify(projectSubscriptions, value.projectId, 'terminal:updated', value);
    },
    terminalOutput(value: TerminalOutput) {
      // Reconnect reads the bounded terminal snapshot instead of buffering a
      // second, unbounded copy of stdout while the durable tree is loading.
      projectSubscriptions
        .get(value.projectId)
        ?.forEach((subscription, socket) => {
          if (subscription.ready) socket.emit('terminal:output', value);
        });
    },
    terminalRemoved(value: {
      readonly projectId: string;
      readonly threadId: string;
      readonly terminalId: string;
    }) {
      notify(projectSubscriptions, value.projectId, 'terminal:removed', value);
    },
    event(value: ThreadEvent) {
      threadSubscriptions
        .get(value.threadId)
        ?.forEach((subscription, socket) => {
          if (value.sequence <= subscription.lastSequence) return;
          subscription.events.set(value.sequence, value);
          if (subscription.ready) flushEvents(socket, subscription);
        });
    },
    threadUpdated(value: Thread) {
      notify(threadSubscriptions, value.id, 'thread:updated', value);
      notify(projectSubscriptions, value.projectId, 'thread:updated', value);
    },
    threadDeleted(projectId: string, threadId: string) {
      const value = { projectId, threadId };
      notify(threadSubscriptions, threadId, 'thread:deleted', value);
      notify(projectSubscriptions, projectId, 'thread:deleted', value);
    },
    projectUpdated(value: Project) {
      notify(projectSubscriptions, value.id, 'project:updated', value);
    },
    projectDeleted(projectId: string) {
      notify(projectSubscriptions, projectId, 'project:deleted', { projectId });
    },
  };
  // One runtime/v1 notice is one WorkspacePublisher callback of before.
  return (notice) => {
    switch (notice.kind) {
      case 'event':
        publisher.event(notice.value);
        return;
      case 'threadUpdated':
        publisher.threadUpdated(notice.value);
        return;
      case 'threadDeleted':
        publisher.threadDeleted(notice.projectId, notice.threadId);
        return;
      case 'projectUpdated':
        publisher.projectUpdated(notice.value);
        return;
      case 'projectDeleted':
        publisher.projectDeleted(notice.projectId);
        return;
      case 'terminalUpdated':
        publisher.terminalUpdated(notice.value);
        return;
      case 'terminalOutput':
        publisher.terminalOutput(notice.value);
        return;
      case 'terminalRemoved':
        publisher.terminalRemoved({
          projectId: notice.projectId,
          threadId: notice.threadId,
          terminalId: notice.terminalId,
        });
        return;
    }
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
