import { randomUUID } from 'node:crypto';

import { defaultConfig } from '../../src/lib/config.js';
import type {
  ProjectRecord,
  ProjectStore,
  ThreadEvent,
  ThreadRecord,
  ThreadStore,
  WorkspacePublisher,
} from '../../src/lib/workspace.js';

export const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** In-memory durable boundaries with notifications for deterministic assertions. */
export const workspace = () => {
  const projectRecords = new Map<string, ProjectRecord>();
  const threadRecords = new Map<string, ThreadRecord>();
  const events: ThreadEvent[] = [];
  const changes = new Set<() => void>();
  const notify = () => {
    for (const change of changes) change();
  };
  const now = new Date(0).toISOString();
  const projects: ProjectStore = {
    create: async (snapshot) => {
      const project = {
        id: randomUUID(),
        state: 'queued' as const,
        configRevision: snapshot.revision,
        createdAt: now,
        updatedAt: now,
      };
      const record = { project, snapshot };
      projectRecords.set(project.id, record);
      notify();
      return record;
    },
    find: async (id) => projectRecords.get(id),
    list: async (limit, cursor) => ({
      items: [...projectRecords.values()]
        .map(({ project }) => project)
        .filter(({ id }) => cursor === undefined || id > cursor)
        .slice(0, limit),
    }),
    setState: async (id, state, errorCode) => {
      const record = projectRecords.get(id);
      if (!record) return undefined;
      const project = {
        ...record.project,
        state,
        ...(errorCode ? { errorCode } : {}),
      };
      projectRecords.set(id, { ...record, project });
      notify();
      return project;
    },
    delete: async (id) => {
      const record = projectRecords.get(id);
      if (!record) return 'missing';
      if (!['cancelled', 'failed'].includes(record.project.state))
        return 'active';
      projectRecords.delete(id);
      return 'deleted';
    },
    reconcile: async () => 0,
  };
  const threads: ThreadStore = {
    create: async (projectId, parentThreadId) => {
      const thread = {
        id: randomUUID(),
        projectId,
        ...(parentThreadId ? { parentThreadId } : {}),
        state: 'queued' as const,
        lastSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      const record = { thread, messages: [] };
      threadRecords.set(thread.id, record);
      notify();
      return record;
    },
    find: async (id) => threadRecords.get(id),
    list: async (projectId, limit, cursor, parentThreadId) => ({
      items: [...threadRecords.values()]
        .map(({ thread }) => thread)
        .filter(
          (thread) =>
            thread.projectId === projectId &&
            (parentThreadId === undefined ||
              thread.parentThreadId === parentThreadId) &&
            (cursor === undefined || thread.id > cursor),
        )
        .slice(0, limit),
    }),
    listByProject: async (projectId) =>
      [...threadRecords.values()]
        .map(({ thread }) => thread)
        .filter((thread) => thread.projectId === projectId),
    setState: async (id, state, activePromptId, errorCode) => {
      const record = threadRecords.get(id);
      if (!record) return undefined;
      const {
        activePromptId: _active,
        errorCode: _error,
        ...previous
      } = record.thread;
      const thread = {
        ...previous,
        state,
        ...(activePromptId ? { activePromptId } : {}),
        ...(errorCode ? { errorCode } : {}),
      };
      threadRecords.set(id, { ...record, thread });
      notify();
      return thread;
    },
    saveMessages: async (id, messages) => {
      const record = threadRecords.get(id);
      if (record) threadRecords.set(id, { ...record, messages });
    },
    appendEvent: async (id, promptId, event) => {
      const record = threadRecords.get(id);
      if (!record) throw new Error('Missing thread');
      const sequence = record.thread.lastSequence + 1;
      const stored = {
        projectId: record.thread.projectId,
        threadId: id,
        promptId,
        sequence,
        type: (event as { type: string }).type,
        event,
        createdAt: now,
      };
      events.push(stored);
      threadRecords.set(id, {
        ...record,
        thread: { ...record.thread, lastSequence: sequence },
      });
      notify();
      return stored;
    },
    eventsAfter: async (id, sequence) =>
      events.filter(
        (event) => event.threadId === id && event.sequence > sequence,
      ),
    deleteSubtree: async () => {
      throw new Error('Deletion is not used in execution tests');
    },
    reconcile: async () => 0,
  };
  const publisher: WorkspacePublisher = {
    event: notify,
    threadUpdated: notify,
    threadDeleted: notify,
    projectUpdated: notify,
    projectDeleted: notify,
  };
  const waitFor = (condition: () => boolean) => {
    if (condition()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!condition()) return;
        changes.delete(check);
        resolve();
      };
      changes.add(check);
    });
  };
  return {
    projects,
    threads,
    publisher,
    events,
    projectState: (id: string, state: string) =>
      waitFor(() => projectRecords.get(id)?.project.state === state),
    threadState: (id: string, state: string) =>
      waitFor(() => threadRecords.get(id)?.thread.state === state),
    dependencies: {
      projects,
      threads,
      publisher,
      config: {
        current: () => ({
          snapshot: {
            configuration: defaultConfig,
            revision: 1,
            updatedAt: now,
          },
          providers: new Map(),
          catalog: { skills: [], tools: [] },
          redactions: () => ['secret-value'],
        }),
      } as never,
      logger: { debug: () => undefined, error: () => undefined } as never,
    },
  };
};

export const sandbox = { id: 'vm-1' };
export const pool = (release: () => void = () => undefined) =>
  ({
    acquire: async () => ({ sandbox, release: async () => release() }),
  }) as never;
