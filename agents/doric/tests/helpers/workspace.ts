import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type {
  Sandbox,
  SandboxDiffInput,
  SandboxExecInput,
  SandboxExecResult,
  WorkspacePathKind,
} from 'sandbox';

import { defaultConfig } from '../../src/lib/config/schema.js';
import type {
  ProjectRecord,
  ProjectStore,
  ThreadEvent,
  ThreadRecord,
  ThreadStore,
  WorkspacePublisher,
} from '../../src/lib/workspace/types.js';

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
    create: async (name, snapshot, color) => {
      const project = {
        id: randomUUID(),
        name,
        color,
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
    rename: async (id, name) => {
      const record = projectRecords.get(id);
      if (!record) return undefined;
      const project = { ...record.project, name };
      projectRecords.set(id, { ...record, project });
      notify();
      return project;
    },
    setColor: async (id, color) => {
      const record = projectRecords.get(id);
      if (!record) return undefined;
      const project = { ...record.project, color };
      projectRecords.set(id, { ...record, project });
      notify();
      return project;
    },
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
    create: async (projectId, name, parentThreadId) => {
      const thread = {
        id: randomUUID(),
        projectId,
        ...(parentThreadId ? { parentThreadId } : {}),
        name,
        state: 'queued' as const,
        lastSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      const record = { thread, messages: [], checkpoints: {} };
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
    rename: async (id, name) => {
      const record = threadRecords.get(id);
      if (!record) return undefined;
      const thread = { ...record.thread, name };
      threadRecords.set(id, { ...record, thread });
      notify();
      return thread;
    },
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
    saveCheckpoint: async (id, promptId) => {
      const record = threadRecords.get(id);
      if (!record) return;
      threadRecords.set(id, {
        ...record,
        checkpoints: {
          ...record.checkpoints,
          [promptId]: record.messages.length,
        },
      });
    },
    rewind: async (id, promptId) => {
      const record = threadRecords.get(id);
      if (!record) return undefined;
      const checkpoint = record.checkpoints[promptId];
      const sequences = events
        .filter((event) => event.threadId === id && event.promptId === promptId)
        .map(({ sequence }) => sequence);
      if (checkpoint === undefined || sequences.length === 0) return undefined;
      const from = Math.min(...sequences);
      const removed = new Set(
        events
          .filter((event) => event.threadId === id && event.sequence >= from)
          .map(({ promptId: id }) => id),
      );
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.threadId === id && event.sequence >= from)
          events.splice(index, 1);
      }
      const afterSequence = Math.max(
        0,
        ...events
          .filter((event) => event.threadId === id)
          .map(({ sequence }) => sequence),
      );
      const sequence = record.thread.lastSequence + 1;
      const marker = {
        projectId: record.thread.projectId,
        threadId: id,
        promptId,
        sequence,
        type: 'history.truncated',
        event: { type: 'history.truncated', afterSequence },
        createdAt: now,
      };
      events.push(marker);
      threadRecords.set(id, {
        ...record,
        messages: record.messages.slice(0, checkpoint),
        checkpoints: Object.fromEntries(
          Object.entries(record.checkpoints).filter(
            ([key]) => !removed.has(key),
          ),
        ),
        thread: { ...record.thread, lastSequence: sequence },
      });
      notify();
      return marker;
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
          registerSecret: () => undefined,
        }),
      } as never,
      logger: { debug: () => undefined, error: () => undefined } as never,
    },
  };
};

export const sandbox = { id: 'vm-1' } as unknown as Sandbox;
export const pool = (
  release: () => void = () => undefined,
  environment: Sandbox = sandbox,
) =>
  ({
    acquire: async () => ({
      sandbox: environment,
      release: async () => release(),
    }),
  }) as never;

/** One scripted workspace entry; a missing `content` marks an empty directory. */
export type FakeSandboxEntry = {
  readonly path: string;
  readonly content?: string;
};

export type FakeSandboxOptions = {
  readonly root?: string;
  readonly id?: string;
  readonly entries?: readonly FakeSandboxEntry[];
  /** `git status --porcelain` output; omit for a workspace with no repository. */
  readonly status?: string;
  readonly diff?: string;
};

/**
 * A deterministic stand-in for a leased sandbox that answers the exact command
 * shapes the workspace file rules issue, so their behavior can be observed
 * without a real VM:
 *
 * - `sh -c '<kind test>' sh <absolute path>` reports directory/file/missing;
 * - `find <absolute dir> [-maxdepth 1] ... -type d|f ...` lists the tree;
 * - `wc -c <absolute paths>` reports each file's byte size;
 * - `head -c <n> -- <path>` returns the first `n` bytes of the file;
 * - `git status --porcelain [-- <path>]` fails when no repository is scripted;
 * - `git config --global <key> <value>` succeeds and is recorded;
 * - any other `sh -c <script>` succeeds as the workspace's own shell helper;
 * - `diff(input)` returns the scripted diff and records the input it received;
 * - `readFile(<absolute path>)` returns a file's content or rejects.
 *
 * Tests may also wrap `exec`, `diff`, or `readFile` after construction.
 */
export const fakeSandbox = (options: FakeSandboxOptions = {}) => {
  const root = options.root ?? '/workspace';
  const files = new Map<string, string>();
  const directories = new Set<string>(['']);
  const execs: SandboxExecInput[] = [];
  const diffs: (SandboxDiffInput | undefined)[] = [];
  const repository = options.status !== undefined;

  const clean = (value: string): string =>
    value.replace(/^\/+/, '').replace(/\/+$/, '');
  const absolute = (path: string): string =>
    path === '' ? root : `${root}/${path}`;
  const relative = (value: string): string => {
    if (value === root) return '';
    if (value.startsWith(`${root}/`)) return value.slice(root.length + 1);
    return clean(value);
  };
  const addParents = (path: string): void => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join('/'));
  };

  for (const entry of options.entries ?? []) {
    const path = clean(entry.path);
    if (entry.content === undefined) {
      directories.add(path);
      addParents(path);
      continue;
    }
    files.set(path, entry.content);
    addParents(path);
  }

  const kindOf = (value: string): WorkspacePathKind => {
    const path = relative(value);
    if (path === '') return 'directory';
    if (files.has(path)) return 'file';
    if (directories.has(path)) return 'directory';
    return 'missing';
  };
  const under = (value: string, base: string): boolean =>
    base === '' || value === base || value.startsWith(`${base}/`);
  const depth = (value: string, base: string): number | undefined => {
    if (!under(value, base)) return undefined;
    const rest =
      base === '' ? value : value === base ? '' : value.slice(base.length + 1);
    return rest === '' ? 0 : rest.split('/').length;
  };
  const find = (args: readonly string[]): string => {
    const base = relative(args[0] ?? root);
    const directoriesOnly = args[args.indexOf('-type') + 1] === 'd';
    const marker = args.indexOf('-maxdepth');
    const maxdepth = marker === -1 ? Infinity : Number(args[marker + 1]);
    const values = directoriesOnly ? [...directories] : [...files.keys()];
    return values
      .filter((value) => {
        const distance = depth(value, base);
        return distance !== undefined && distance <= maxdepth;
      })
      .map((value) => absolute(value))
      .join('\n');
  };
  const exec = async (input: SandboxExecInput): Promise<SandboxExecResult> => {
    execs.push(input);
    const [command, ...args] = input.cmd;
    // The path test passes a positional argument; a shell helper does not.
    if (command === 'sh')
      return ok(args.length > 2 ? kindOf(args.at(-1) ?? root) : '');
    if (command === 'find') return ok(find(args));
    if (command === 'wc')
      return ok(
        args
          .slice(1)
          .map(
            (path) =>
              `${String(Buffer.byteLength(files.get(relative(path)) ?? '', 'utf8'))} ${path}`,
          )
          .join('\n'),
      );
    if (command === 'head') {
      const marker = args.indexOf('--');
      const bytes = Buffer.from(
        files.get(relative(args[marker + 1] ?? '')) ?? '',
      );
      return bytesResult(bytes.subarray(0, Number(args[1])));
    }
    if (command === 'git' && args[0] === 'status')
      return repository
        ? ok(options.status ?? '')
        : bytesResult(new Uint8Array(), 128);
    if (command === 'git' && args[0] === 'config') return ok('');
    throw new Error(`Unscripted sandbox command: ${input.cmd.join(' ')}`);
  };

  return {
    id: options.id ?? 'vm-1',
    root,
    exec,
    diff: async (input?: SandboxDiffInput) => {
      diffs.push(input);
      return options.diff ?? '';
    },
    readFile: async (path: string) => {
      const value = files.get(relative(path));
      if (value === undefined) throw new Error(`No scripted file: ${path}`);
      return value;
    },
    cloneRepo: async () => {
      throw new Error('cloneRepo is not scripted');
    },
    writeFile: async () => {
      throw new Error('writeFile is not scripted');
    },
    putFile: async () => {
      throw new Error('putFile is not scripted');
    },
    getFile: async () => {
      throw new Error('getFile is not scripted');
    },
    ssh: async () => undefined,
    execs,
    diffs,
  };
};

const empty = new Uint8Array();

const ok = (stdout: string): SandboxExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  stdoutBytes: Buffer.from(stdout),
  stderrBytes: empty,
});

const bytesResult = (bytes: Uint8Array, exitCode = 0): SandboxExecResult => ({
  exitCode,
  stdout: Buffer.from(bytes).toString('utf8'),
  stderr: '',
  stdoutBytes: bytes,
  stderrBytes: empty,
});
