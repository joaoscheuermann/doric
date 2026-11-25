// `runtime.records/v1` (bundle isolation phase 3): the window's mirror of the
// host's Projects and Threads, over `runtime/v2` and `runtime.threads/v1`.
// Reads answer from memory and start the first load of what they read;
// `follow` keeps a Project current through its watch; writes go through the
// host adapter and put the host's answer into the mirror before they resolve.

import type { Client } from '@connectrpc/connect';
import type { Disposable } from 'bundle/contracts';
import { ClientError } from 'desktop/reads';

import type { ThreadsService } from '../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import type {
  Project,
  RecordsRead,
  RuntimeRecords,
  Thread,
} from '../contracts/index.js';
import type { RuntimeHost, ThreadsHost } from './api/host.js';
import {
  type ConnectionSource,
  createProjectWatch,
  defaultSchedule,
} from './api/project-watch.js';
import { createThreadViews } from './api/thread-views.js';
import { createWorkspaceApi, hostFailure } from './api/workspace-api.js';
import {
  applyUpdate,
  forgetProject,
  forgetThread,
  type RecordsTree,
  type TreeUpdate,
  withProject,
  withProjects,
  withThread,
  withThreads,
} from './domain/tree.js';
import { followProject } from './follow.js';
import {
  createRecordsStore,
  type ReadState,
  type RecordsError,
  type RecordsState,
} from './stores/records.js';

export interface RecordsHosts {
  readonly runtime: RuntimeHost;
  readonly threads: ThreadsHost;
  /**
   * The client whose `ViewThread` streams hold the window's views; without
   * it, `view` holds no stream.
   */
  readonly views?: Pick<Client<typeof ThreadsService>, 'viewThread'>;
  readonly connection: ConnectionSource;
  /** The timer of the watches and views; `defaultSchedule` when absent. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /** The wait between the tries of a delete; 500 ms when absent. */
  readonly pause?: () => Promise<void>;
}

const loading: ReadState = { status: 'loading' };
const ready: ReadState = { status: 'ready' };

const failed = (error: unknown): ReadState => ({
  status: 'failed',
  error: error instanceof ClientError ? error : hostFailure(error),
});

/** `record` without `key`. */
const without = <Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** A `Disposable` whose `dispose` runs `run` once. */
const once = (run: () => void): Disposable => {
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      run();
    },
  };
};

const noop: Disposable = { dispose: () => undefined };

/**
 * The state after a change of a described Project's Threads: a load of
 * those Threads in flight is dropped, and the read is ready (R2).
 */
const withChangedThreads = (
  state: RecordsState,
  projectId: string,
  tree: RecordsTree,
): Partial<RecordsState> =>
  state.inFlight.threads[projectId] === undefined
    ? { tree }
    : {
        tree,
        threads: { ...state.threads, [projectId]: ready },
        inFlight: {
          ...state.inFlight,
          threads: without(state.inFlight.threads, projectId),
        },
      };

/**
 * A cache of reads: the read of `state` over `value` stays the same object
 * while neither changes, so a reader can compare answers by identity.
 */
const memoRead = <Value>() => {
  const reads = new Map<
    string,
    {
      readonly state: ReadState;
      readonly value: Value | undefined;
      readonly read: RecordsRead<Value>;
    }
  >();
  return (
    key: string,
    state: ReadState,
    value: Value | undefined,
  ): RecordsRead<Value> => {
    const cached = reads.get(key);
    if (cached?.state === state && cached.value === value) return cached.read;
    const read: RecordsRead<Value> =
      state.status === 'failed'
        ? {
            status: 'failed',
            ...(value === undefined ? {} : { value }),
            error: state.error,
          }
        : state.status === 'ready' && value !== undefined
          ? { status: 'ready', value }
          : { status: 'loading', ...(value === undefined ? {} : { value }) };
    reads.set(key, { state, value, read });
    return read;
  };
};

/** The mirror over the hosts; `close` ends every watch and view it holds. */
export const createRecords = (
  hosts: RecordsHosts,
): RuntimeRecords & { close(): void } => {
  const schedule = hosts.schedule ?? defaultSchedule;
  const api = createWorkspaceApi({
    runtime: hosts.runtime,
    threads: hosts.threads,
    ...(hosts.pause === undefined ? {} : { pause: hosts.pause }),
  });
  const store = createRecordsStore(hosts.connection.status());
  const get = store.getState;
  const set = (next: Partial<RecordsState>) => store.setState(next);
  let closed = false;
  let sequence = 0;

  const connection = hosts.connection.subscribe((status) => {
    if (get().connection !== status) set({ connection: status });
  });

  // Reads ------------------------------------------------------------------

  const projectsRead = memoRead<readonly Project[]>();
  const threadsRead = memoRead<readonly Thread[]>();

  const describedThread = (threadId: string): Thread | undefined => {
    for (const threads of Object.values(get().tree.threadsByProject)) {
      const found = threads.find((thread) => thread.id === threadId);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  // Loads ------------------------------------------------------------------

  const loadProjects = () => {
    const current = ++sequence;
    set({
      projects: loading,
      inFlight: { ...get().inFlight, projects: current },
    });
    const settle = (change: (state: RecordsState) => Partial<RecordsState>) => {
      const state = get();
      if (state.inFlight.projects !== current) return;
      set({ ...change(state), inFlight: { threads: state.inFlight.threads } });
    };
    api.projects.list().then(
      (projects) =>
        settle((state) => ({
          tree: withProjects(state.tree, projects),
          projectsListed: true,
          projects: ready,
        })),
      (error: unknown) => settle(() => ({ projects: failed(error) })),
    );
  };

  const loadThreads = (projectId: string) => {
    const current = ++sequence;
    const state = get();
    set({
      threads: { ...state.threads, [projectId]: loading },
      inFlight: {
        ...state.inFlight,
        threads: { ...state.inFlight.threads, [projectId]: current },
      },
    });
    const settle = (
      change: (state: RecordsState) => Partial<RecordsState>,
      read: ReadState,
    ) => {
      const state = get();
      if (state.inFlight.threads[projectId] !== current) return;
      set({
        ...change(state),
        threads: { ...state.threads, [projectId]: read },
        inFlight: {
          ...state.inFlight,
          threads: without(state.inFlight.threads, projectId),
        },
      });
    };
    api.threads.list(projectId).then(
      (threads) =>
        settle(
          (state) => ({ tree: withThreads(state.tree, projectId, threads) }),
          ready,
        ),
      (error: unknown) => settle(() => ({}), failed(error)),
    );
  };

  // Follows ----------------------------------------------------------------

  const notice = (projectId: string, update: TreeUpdate) => {
    const state = get();
    switch (update.kind) {
      case 'snapshot':
        set({
          tree: applyUpdate(state.tree, update),
          threads: { ...state.threads, [projectId]: ready },
          inFlight: {
            ...state.inFlight,
            threads: without(state.inFlight.threads, projectId),
          },
        });
        return;
      case 'thread-updated':
        if (state.tree.threadsByProject[projectId] === undefined) return;
        set(
          withChangedThreads(state, projectId, applyUpdate(state.tree, update)),
        );
        return;
      case 'thread-deleted':
        set(
          withChangedThreads(state, projectId, applyUpdate(state.tree, update)),
        );
        return;
      case 'project-updated':
        set({ tree: applyUpdate(state.tree, update) });
        return;
      case 'project-deleted':
        set({
          tree: applyUpdate(state.tree, update),
          threads: without(state.threads, projectId),
          inFlight: {
            ...state.inFlight,
            threads: without(state.inFlight.threads, projectId),
          },
        });
        return;
    }
  };

  const streamFailed = (projectId: string, error: RecordsError) => {
    const state = get();
    set({
      threads: { ...state.threads, [projectId]: { status: 'failed', error } },
    });
  };

  const follows = new Map<string, { count: number; stop: () => void }>();

  // Views ------------------------------------------------------------------

  const views =
    hosts.views === undefined
      ? undefined
      : createThreadViews({
          runtime: hosts.views,
          connection: hosts.connection,
          schedule,
        });
  const held = new Map<string, number>();
  const syncViews = () => {
    if (!closed) views?.set(new Set(held.keys()));
  };

  // Writes -----------------------------------------------------------------

  /** Puts the Threads into the Projects they belong to, if described. */
  const putThreads = (threads: readonly Thread[]) => {
    for (const thread of threads) {
      const state = get();
      if (state.tree.threadsByProject[thread.projectId] === undefined) continue;
      set(
        withChangedThreads(
          state,
          thread.projectId,
          withThread(state.tree, thread),
        ),
      );
    }
  };

  const putProject = (project: Project) => {
    set({ tree: withProject(get().tree, project) });
  };

  return {
    projects: () => {
      if (get().projects === undefined) loadProjects();
      const state = get();
      return projectsRead(
        'projects',
        state.projects ?? loading,
        state.projectsListed ? state.tree.projects : undefined,
      );
    },
    project: (projectId) =>
      get().tree.projects.find((project) => project.id === projectId),
    threads: (projectId) => {
      const before = get();
      if (
        before.threads[projectId] === undefined &&
        before.tree.threadsByProject[projectId] === undefined
      ) {
        loadThreads(projectId);
      }
      const state = get();
      return threadsRead(
        projectId,
        state.threads[projectId] ?? ready,
        state.tree.threadsByProject[projectId],
      );
    },
    thread: describedThread,
    connection: () => get().connection,
    subscribe: (listener) => once(store.subscribe(() => listener())),

    follow: ({ projectId }) => {
      if (closed) return noop;
      let entry = follows.get(projectId);
      if (entry === undefined) {
        const watch = createProjectWatch({
          runtime: hosts.runtime,
          connection: hosts.connection,
          schedule,
        });
        const stop = followProject(watch, {
          projectId,
          onUpdate: (update) => notice(projectId, update),
          onError: (error) => streamFailed(projectId, error),
        });
        entry = {
          count: 0,
          stop: () => {
            stop();
            watch.close();
          },
        };
        follows.set(projectId, entry);
      }
      const followed = entry;
      followed.count += 1;
      return once(() => {
        if (follows.get(projectId) !== followed) return;
        followed.count -= 1;
        if (followed.count > 0) return;
        follows.delete(projectId);
        followed.stop();
      });
    },
    reload: (input) => {
      if (input.target === 'projects') loadProjects();
      else loadThreads(input.projectId);
    },
    findThread: ({ threadId }) => api.threads.get(threadId),
    activity: () => api.projects.activity(),

    createProject: async ({ name }) => {
      const created = await api.projects.create(name);
      const state = get();
      set({
        tree: withThreads(withProject(state.tree, created), created.id, []),
      });
      return created;
    },
    renameProject: async ({ projectId, name }) => {
      const renamed = await api.projects.rename(projectId, name);
      putProject(renamed);
      return renamed;
    },
    setProjectColor: async ({ projectId, color }) => {
      const colored = await api.projects.setColor(projectId, color);
      putProject(colored);
      return colored;
    },
    terminateProject: async ({ projectId }) => {
      const terminated = await api.projects.terminate(projectId);
      putProject(terminated);
      return terminated;
    },
    deleteProject: async ({ projectId }) => {
      await api.projects.delete(projectId);
      const state = get();
      set({
        tree: forgetProject(state.tree, projectId),
        threads: without(state.threads, projectId),
        inFlight: {
          ...state.inFlight,
          threads: without(state.inFlight.threads, projectId),
        },
      });
    },
    createThread: async ({ projectId, name, parentThreadId }) => {
      const created = await api.threads.create(projectId, name, parentThreadId);
      putThreads([created]);
      return created;
    },
    renameThread: async ({ threadId, name }) => {
      const renamed = await api.threads.rename(threadId, name);
      putThreads([renamed]);
      return renamed;
    },
    terminateThread: async ({ threadId }) => {
      const terminated = await api.threads.terminate(threadId);
      putThreads([terminated]);
      return terminated;
    },
    deleteThread: async ({ threadId }) => {
      await api.threads.delete(threadId);
      const deleted = describedThread(threadId);
      if (deleted === undefined) return;
      const state = get();
      set(
        withChangedThreads(
          state,
          deleted.projectId,
          forgetThread(state.tree, deleted.projectId, threadId),
        ),
      );
    },
    archiveThread: async ({ threadId }) => {
      const archived = await api.threads.archive(threadId);
      putThreads(archived.threads);
      return archived;
    },
    restoreThread: async ({ threadId, batch }) => {
      const restored = await api.threads.restore(threadId, batch);
      putThreads(restored);
      return restored;
    },
    setThreadPinned: async ({ threadId, pinned }) => {
      const updated = await api.threads.setPinned(threadId, pinned);
      putThreads([updated]);
      return updated;
    },

    view: ({ threadId }) => {
      if (closed) return noop;
      held.set(threadId, (held.get(threadId) ?? 0) + 1);
      syncViews();
      return once(() => {
        const count = held.get(threadId);
        if (count === undefined) return;
        if (count > 1) held.set(threadId, count - 1);
        else held.delete(threadId);
        syncViews();
      });
    },

    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of follows.values()) entry.stop();
      follows.clear();
      held.clear();
      views?.close();
      connection.dispose();
    },
  };
};
