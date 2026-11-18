// `runtime/testing` (bundle isolation phase 3): an in-memory
// `runtime.records/v1` for the tests and stories of the bundles that read it.
// Browser-safe: it imports only the runtime's contracts and `bundle/contracts`,
// and no file of the runtime's client part.

import type {
  Disposable,
  ImplementationOf,
  ServiceDefinition,
} from 'bundle/contracts';

import {
  type Project,
  type ProjectActivity,
  type RecordsRead,
  type RuntimeRecords,
  type RuntimeRecordsV1,
  runtimeRecordsService,
  type Thread,
  threadSubtreeIds,
} from './contracts/index.js';

const unreachableCode = 'unavailable';
const unreachableMessage = 'The host is unreachable.';

/** The reads a fake can hold back or fail. */
export type RecordsOperation =
  | 'projects'
  | 'threads'
  | 'activity'
  | 'findThread';

export interface RecordsFakeOptions {
  readonly projects?: readonly Project[];
  /** The Threads of every Project. A Project is described from the first `threads(projectId)` call on. */
  readonly threads?: readonly Thread[];
  readonly activity?: readonly ProjectActivity[];
  /** `connected` when absent. */
  readonly connection?: 'connected' | 'disconnected';
  /** Reads that answer `loading` for good; `activity` and `findThread` then never settle. */
  readonly pending?: readonly RecordsOperation[];
  /**
   * Reads that answer `failed`, and promises that reject with an `Error` that
   * has the property `code`. Both carry the code `unavailable` and the message
   * "The host is unreachable."
   */
  readonly failing?: readonly RecordsOperation[];
}

/**
 * `runtime.records/v1` in memory, as a plain object: no host, no watch and no
 * timer. A read that is neither pending nor failing answers `ready` at once,
 * from the options; a write changes the fake's records as the host would,
 * calls the subscribers and resolves with the record. Each call makes a new,
 * independent fake.
 */
export const createRecordsApi = (
  options?: RecordsFakeOptions,
): RuntimeRecords => {
  const pending = new Set(options?.pending ?? []);
  const failing = new Set(options?.failing ?? []);
  const activity = options?.activity ?? [];
  const connection = options?.connection ?? 'connected';
  let projects: readonly Project[] = [...(options?.projects ?? [])];
  let threads: readonly Thread[] = [...(options?.threads ?? [])];
  /** The archive batch of each archived Thread the fake archived. */
  const batches = new Map<string, string>();
  const described = new Set<string>();
  const listeners = new Set<() => void>();
  let next = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const unreachable = () =>
    Object.assign(new Error(unreachableMessage), { code: unreachableCode });
  const missing = (what: string) =>
    Object.assign(new Error(`The ${what} was not found.`), {
      code: 'not_found',
    });
  /** A read of `value` as `operation` answers it. */
  const readOf = <Value>(
    operation: RecordsOperation,
    value: Value,
  ): RecordsRead<Value> => {
    if (pending.has(operation)) return { status: 'loading' };
    if (failing.has(operation)) {
      return { status: 'failed', error: unreachable() };
    }
    return { status: 'ready', value };
  };
  /** A promise of `value` as `operation` answers it. */
  const answer = <Value>(
    operation: RecordsOperation,
    value: () => Value,
  ): Promise<Value> => {
    if (pending.has(operation)) return new Promise<Value>(() => undefined);
    if (failing.has(operation)) return Promise.reject(unreachable());
    return Promise.resolve(value());
  };
  const now = () => new Date().toISOString();
  const findProject = (projectId: string): Project => {
    const found = projects.find((project) => project.id === projectId);
    if (found === undefined) throw missing('project');
    return found;
  };
  const findThread = (threadId: string): Thread => {
    const found = threads.find((thread) => thread.id === threadId);
    if (found === undefined) throw missing('thread');
    return found;
  };
  const putProject = (value: Project): Project => {
    projects = projects.map((project) =>
      project.id === value.id ? value : project,
    );
    notify();
    return value;
  };
  const putThreads = (values: readonly Thread[]): readonly Thread[] => {
    const byId = new Map(values.map((value) => [value.id, value]));
    threads = threads.map((thread) => byId.get(thread.id) ?? thread);
    notify();
    return values;
  };
  const write = async <Value>(run: () => Value): Promise<Value> => run();
  const held = (): Disposable => ({ dispose: () => undefined });

  return {
    projects: () => readOf('projects', projects),
    project: (projectId) =>
      projects.find((project) => project.id === projectId),
    threads: (projectId) => {
      described.add(projectId);
      return readOf(
        'threads',
        threads.filter((thread) => thread.projectId === projectId),
      );
    },
    thread: (threadId) =>
      pending.has('threads') || failing.has('threads')
        ? undefined
        : threads.find(
            (thread) =>
              thread.id === threadId && described.has(thread.projectId),
          ),
    connection: () => connection,
    subscribe: (listener) => {
      const subscribed = () => listener();
      listeners.add(subscribed);
      return { dispose: () => void listeners.delete(subscribed) };
    },
    follow: held,
    reload: () => notify(),
    findThread: ({ threadId }) =>
      answer('findThread', () =>
        threads.find((thread) => thread.id === threadId),
      ),
    activity: () => answer('activity', () => activity),
    createProject: ({ name }) =>
      write(() => {
        next += 1;
        const at = now();
        const created: Project = {
          id: `project-${next}`,
          name,
          state: 'ready',
          configRevision: 0,
          createdAt: at,
          updatedAt: at,
        };
        projects = [...projects, created];
        described.add(created.id);
        notify();
        return created;
      }),
    renameProject: ({ projectId, name }) =>
      write(() => putProject({ ...findProject(projectId), name })),
    setProjectColor: ({ projectId, color }) =>
      write(() => {
        const { color: _color, ...rest } = findProject(projectId);
        return putProject(color === undefined ? rest : { ...rest, color });
      }),
    terminateProject: ({ projectId }) =>
      write(() =>
        putProject({ ...findProject(projectId), state: 'cancelled' }),
      ),
    deleteProject: ({ projectId }) =>
      write(() => {
        findProject(projectId);
        projects = projects.filter((project) => project.id !== projectId);
        threads = threads.filter((thread) => thread.projectId !== projectId);
        notify();
      }),
    createThread: ({ projectId, name, parentThreadId }) =>
      write(() => {
        findProject(projectId);
        next += 1;
        const at = now();
        const created: Thread = {
          id: `thread-${next}`,
          projectId,
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
          name,
          state: 'ready',
          lastSequence: 0,
          cwd: '/workspace',
          createdAt: at,
          updatedAt: at,
        };
        threads = [...threads, created];
        notify();
        return created;
      }),
    renameThread: ({ threadId, name }) =>
      write(() => {
        const renamed = { ...findThread(threadId), name };
        putThreads([renamed]);
        return renamed;
      }),
    terminateThread: ({ threadId }) =>
      write(() => {
        const terminated: Thread = {
          ...findThread(threadId),
          state: 'cancelled',
        };
        putThreads([terminated]);
        return terminated;
      }),
    deleteThread: ({ threadId }) =>
      write(() => {
        findThread(threadId);
        const ids = threadSubtreeIds(threads, threadId);
        threads = threads.filter((thread) => !ids.has(thread.id));
        notify();
      }),
    archiveThread: ({ threadId }) =>
      write(() => {
        const target = findThread(threadId);
        next += 1;
        const batch = `batch-${next}`;
        const at = now();
        const ids = threadSubtreeIds(threads, threadId);
        const marked = [
          target,
          ...threads.filter(
            (thread) =>
              thread.id !== threadId &&
              ids.has(thread.id) &&
              thread.archivedAt === undefined &&
              thread.state !== 'running' &&
              thread.pinned !== true,
          ),
        ].map((thread) => ({ ...thread, archivedAt: at }));
        for (const thread of marked) batches.set(thread.id, batch);
        return { batch, threads: putThreads(marked) };
      }),
    restoreThread: ({ threadId, batch }) =>
      write(() => {
        findThread(threadId);
        const of = batch ?? batches.get(threadId);
        const ids = threadSubtreeIds(threads, threadId);
        const restored = threads
          .filter(
            (thread) =>
              ids.has(thread.id) &&
              thread.archivedAt !== undefined &&
              batches.get(thread.id) === of,
          )
          .map(({ archivedAt: _archivedAt, ...rest }) => {
            batches.delete(rest.id);
            return rest;
          });
        return putThreads(restored);
      }),
    setThreadPinned: ({ threadId, pinned }) =>
      write(() => {
        const { pinned: _pinned, ...rest } = findThread(threadId);
        const updated = pinned ? { ...rest, pinned: true } : rest;
        putThreads([updated]);
        return updated;
      }),
    view: held,
  };
};

/**
 * The same object as `createRecordsApi(options)` behind a service definition
 * of `runtime.records/v1`, for `createTestServices({ provide })`.
 */
export const createRecordsFake = (
  options?: RecordsFakeOptions,
): ServiceDefinition<
  'runtime.records/v1',
  ImplementationOf<typeof RuntimeRecordsV1>
> => runtimeRecordsService(createRecordsApi(options));
