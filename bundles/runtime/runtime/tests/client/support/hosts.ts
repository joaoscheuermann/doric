// A fake `runtime/v1`, a fake `runtime.threads/v1` and a fake connection for
// the records mirror's tests (bundle isolation phase 3, T3.1 to T3.9). The
// fakes keep the host's records in memory and answer as the host does; a test
// replaces a member to make one call wait or fail.

import type { TestContext } from 'node:test';

import type {
  ConnectionStatus,
  ContractError,
  Disposable,
  StreamListener,
  StreamObserver,
} from 'bundle/contracts';

import { createRecords } from '../../../src/client/records.js';
import type {
  Project,
  ProjectActivity,
  ProjectWatchInput,
  ProjectWatchItem,
  Runtime,
  RuntimeRecords,
  RuntimeThreads,
  Thread,
  ThreadViewInput,
  ThreadViewItem,
} from '../../../src/contracts/index.js';

type Writable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** The members of `runtime/v1` the mirror calls (`RuntimeHost`). */
type RuntimeHost = Pick<
  Runtime,
  | 'projects'
  | 'projectActivity'
  | 'createProject'
  | 'renameProject'
  | 'setProjectColor'
  | 'terminateProject'
  | 'deleteProject'
  | 'watchProject'
>;

/** The members of `runtime.threads/v1` the mirror calls (`ThreadsHost`). */
type ThreadsHost = Pick<
  RuntimeThreads,
  | 'threads'
  | 'thread'
  | 'createThread'
  | 'renameThread'
  | 'terminateThread'
  | 'deleteThread'
  | 'archiveThread'
  | 'restoreThread'
  | 'setThreadPinned'
  | 'viewThread'
>;

/** A UUID the adapter's route checks accept, numbered for readability. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const project = (id: string, name = `Project ${id}`): Project => ({
  id,
  name,
  state: 'ready',
  configRevision: 0,
  createdAt: '',
  updatedAt: '',
});

export const thread = (
  id: string,
  projectId: string,
  parentThreadId?: string,
): Thread => ({
  id,
  projectId,
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
  name: `Thread ${id}`,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

/** Lets every pending promise and `setImmediate` callback run. */
export const flush = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

export const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** One stream the host opened. */
export interface Stream<Input, Item> {
  readonly input: Input;
  readonly observer: StreamObserver<Item>;
  disposed: boolean;
}

const open = <Input, Item>(
  streams: Stream<Input, Item>[],
  input: Input,
  listener: StreamListener<Item>,
): Disposable => {
  const stream: Stream<Input, Item> = {
    input,
    observer: typeof listener === 'function' ? { next: listener } : listener,
    disposed: false,
  };
  streams.push(stream);
  return {
    dispose: () => {
      stream.disposed = true;
    },
  };
};

/** The open streams of `streams`. */
export const openOf = <Input, Item>(
  streams: readonly Stream<Input, Item>[],
): readonly Stream<Input, Item>[] =>
  streams.filter(({ disposed }) => !disposed);

/** The host ends a stream, as a provider does. */
export const end = <Input, Item>(
  stream: Stream<Input, Item>,
  error?: ContractError,
): void => {
  stream.disposed = true;
  stream.observer.end?.(error);
};

export class FakeConnection {
  current: ConnectionStatus = 'connected';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  status(): ConnectionStatus {
    return this.current;
  }

  subscribe(listener: (status: ConnectionStatus) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  report(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of [...this.listeners]) listener(status);
  }
}

export interface FakeHost {
  /** The host's own records; the fakes read and write them. */
  readonly state: {
    projects: Project[];
    threads: Thread[];
    activity: ProjectActivity[];
  };
  /** Every host call, as `<method>` in call order. */
  readonly calls: string[];
  readonly watches: Stream<ProjectWatchInput, ProjectWatchItem>[];
  readonly views: Stream<ThreadViewInput, ThreadViewItem>[];
  readonly runtime: Writable<RuntimeHost>;
  readonly threads: Writable<ThreadsHost>;
  readonly connection: FakeConnection;
  /** Runs every scheduled timer once. */
  fireTimers(): void;
  readonly schedule: (run: () => void, ms: number) => () => void;
}

/** The archive batch the fake host writes. */
export const archiveBatch = 'batch-1';

export const createHost = (
  seed: {
    readonly projects?: readonly Project[];
    readonly threads?: readonly Thread[];
    readonly activity?: readonly ProjectActivity[];
  } = {},
): FakeHost => {
  const state = {
    projects: [...(seed.projects ?? [])],
    threads: [...(seed.threads ?? [])],
    activity: [...(seed.activity ?? [])],
  };
  const calls: string[] = [];
  const watches: Stream<ProjectWatchInput, ProjectWatchItem>[] = [];
  const views: Stream<ThreadViewInput, ThreadViewItem>[] = [];
  const timers: (() => void)[] = [];
  let next = 1000;

  const findProject = (id: string) => state.projects.find((p) => p.id === id);
  const findThread = (id: string) => state.threads.find((t) => t.id === id);
  const putProject = (value: Project) => {
    state.projects = state.projects.map((p) => (p.id === value.id ? value : p));
    return value;
  };
  const putThread = (value: Thread) => {
    state.threads = state.threads.map((t) => (t.id === value.id ? value : t));
    return value;
  };
  const subtree = (rootId: string): Set<string> => {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of state.threads) {
        if (
          t.parentThreadId !== undefined &&
          ids.has(t.parentThreadId) &&
          !ids.has(t.id)
        ) {
          ids.add(t.id);
          changed = true;
        }
      }
    }
    return ids;
  };

  const runtime: Writable<RuntimeHost> = {
    projects: async () => {
      calls.push('projects');
      return { items: [...state.projects] };
    },
    projectActivity: async () => {
      calls.push('projectActivity');
      return [...state.activity];
    },
    createProject: async ({ name }) => {
      calls.push('createProject');
      const created = project(uuid(next++), name);
      state.projects.push(created);
      return created;
    },
    renameProject: async ({ id, name }) => {
      calls.push('renameProject');
      const found = findProject(id);
      return found === undefined ? undefined : putProject({ ...found, name });
    },
    setProjectColor: async ({ id, color }) => {
      calls.push('setProjectColor');
      const found = findProject(id);
      if (found === undefined) return undefined;
      const { color: _color, ...rest } = found;
      return putProject(color === null ? rest : { ...rest, color });
    },
    terminateProject: async (id) => {
      calls.push('terminateProject');
      const found = findProject(id);
      return found === undefined
        ? undefined
        : putProject({ ...found, state: 'cancelled' });
    },
    deleteProject: async (id) => {
      calls.push('deleteProject');
      if (findProject(id) === undefined) return 'missing';
      state.projects = state.projects.filter((p) => p.id !== id);
      state.threads = state.threads.filter((t) => t.projectId !== id);
      return 'deleted';
    },
    watchProject: (input, listener) => {
      calls.push('watchProject');
      return open(watches, input, listener);
    },
  };

  const threads: Writable<ThreadsHost> = {
    threads: async ({ projectId }) => {
      calls.push('threads');
      if (findProject(projectId) === undefined) return undefined;
      return { items: state.threads.filter((t) => t.projectId === projectId) };
    },
    thread: async (id) => {
      calls.push('thread');
      return findThread(id);
    },
    createThread: async ({ projectId, name, parentThreadId }) => {
      calls.push('createThread');
      if (findProject(projectId) === undefined) return { status: 'missing' };
      const created = {
        ...thread(uuid(next++), projectId, parentThreadId),
        name,
      };
      state.threads.push(created);
      return { status: 'created', thread: created };
    },
    renameThread: async ({ id, name }) => {
      calls.push('renameThread');
      const found = findThread(id);
      return found === undefined ? undefined : putThread({ ...found, name });
    },
    terminateThread: async (id) => {
      calls.push('terminateThread');
      const found = findThread(id);
      return found === undefined
        ? undefined
        : putThread({ ...found, state: 'cancelled' });
    },
    deleteThread: async (id) => {
      calls.push('deleteThread');
      if (findThread(id) === undefined) return 'missing';
      const ids = subtree(id);
      state.threads = state.threads.filter((t) => !ids.has(t.id));
      return 'deleted';
    },
    archiveThread: async ({ id }) => {
      calls.push('archiveThread');
      const target = findThread(id);
      if (target === undefined) return { status: 'missing' };
      if (target.archivedAt !== undefined)
        return { status: 'already_archived' };
      if (target.state === 'running') return { status: 'busy' };
      const ids = subtree(id);
      const marked = state.threads
        .filter(
          (t) =>
            t.id === id ||
            (ids.has(t.id) &&
              t.archivedAt === undefined &&
              t.state !== 'running' &&
              t.pinned !== true),
        )
        .map((t) =>
          putThread({ ...t, archivedAt: '2026-11-18T12:00:00.000Z' }),
        );
      return {
        status: 'archived',
        batch: archiveBatch,
        threads: [
          ...marked.filter((t) => t.id === id),
          ...marked.filter((t) => t.id !== id),
        ],
      };
    },
    restoreThread: async ({ id }) => {
      calls.push('restoreThread');
      const target = findThread(id);
      if (target === undefined) return { status: 'missing' };
      const ids = subtree(id);
      const restored = state.threads
        .filter((t) => ids.has(t.id) && t.archivedAt !== undefined)
        .map(({ archivedAt: _archivedAt, ...rest }) => putThread(rest));
      return restored.length === 0
        ? { status: 'not_archived' }
        : { status: 'restored', threads: restored };
    },
    setThreadPinned: async ({ id, pinned }) => {
      calls.push('setThreadPinned');
      const found = findThread(id);
      if (found === undefined) return undefined;
      const { pinned: _pinned, ...rest } = found;
      return putThread(pinned ? { ...rest, pinned: true } : rest);
    },
    viewThread: (input, listener) => {
      calls.push('viewThread');
      return open(views, input, listener);
    },
  };

  return {
    state,
    calls,
    watches,
    views,
    runtime,
    threads,
    connection: new FakeConnection(),
    fireTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  };
};

/** The mirror over `host`, closed when the test ends. */
export const mirrorOf = (
  t: TestContext,
  host: FakeHost,
): RuntimeRecords & { close(): void } => {
  const records = createRecords({
    runtime: host.runtime,
    threads: host.threads,
    connection: host.connection,
    schedule: host.schedule,
    pause: async () => undefined,
  });
  t.after(() => records.close());
  return records;
};

/** Counts the calls of a subscriber of `records`. */
export const countNotices = (
  t: TestContext,
  records: RuntimeRecords,
): { readonly count: () => number } => {
  let notices = 0;
  const subscription = records.subscribe(() => {
    notices += 1;
  });
  t.after(() => subscription.dispose());
  return { count: () => notices };
};
