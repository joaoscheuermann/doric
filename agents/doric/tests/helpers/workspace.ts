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
  Credential,
  CredentialKind,
} from '../../src/lib/credentials/kind.js';
import {
  credentialById,
  credentialByKind,
} from '../../src/lib/credentials/resolve.js';
import type {
  ProjectRecord,
  ProjectStore,
  ThreadEvent,
  ThreadRecord,
  ThreadStore,
  WorkspacePublisher,
} from '../../src/lib/workspace/types.js';

/**
 * The resolution half of the credential service, over a live list. Tests that
 * only need a Project to receive credentials use this instead of a store, and
 * `secrets` follows the list so redaction stays honest.
 */
/**
 * A credential service over a live credential list, with the secrets the host
 * learned recorded in `registered`, exactly as the real service records them, so
 * a case can assert what redaction covers after a rotation.
 */
export const credentialResolver = (
  list: () => readonly Credential[] = () => [],
  registered: string[] = [],
) => {
  return {
    list,
    find: (id: string) => list().find(({ id: stored }) => stored === id),
    byId: (id: string) => credentialById(list(), id),
    byKind: (kind: CredentialKind) => credentialByKind(list(), kind),
    byUnclaimedKind: (kind: CredentialKind, claimed: ReadonlySet<string>) =>
      credentialByKind(
        list().filter(({ id }) => !claimed.has(id)),
        kind,
      ),
    secrets: () => [
      ...list().flatMap(({ secret }) =>
        secret === undefined || secret === '' ? [] : [secret],
      ),
      ...registered,
    ],
    register: (secret: string) => {
      if (secret !== '') registered.push(secret);
    },
  } as never;
};

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
    record: (id) => Promise.resolve(projectRecords.get(id)?.project),
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
    create: async (projectId, name, parentThreadId, inherit) => {
      const thread = {
        id: randomUUID(),
        projectId,
        ...(parentThreadId ? { parentThreadId } : {}),
        name,
        state: 'queued' as const,
        lastSequence: 0,
        cwd: inherit?.cwd ?? '/workspace',
        ...(inherit?.cwdRepo === undefined ? {} : { cwdRepo: inherit.cwdRepo }),
        createdAt: now,
        updatedAt: now,
      };
      const record = { thread, messages: [], checkpoints: {} };
      threadRecords.set(thread.id, record);
      notify();
      return record;
    },
    find: async (id) => threadRecords.get(id),
    record: (id) => Promise.resolve(threadRecords.get(id)?.thread),
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
    setCwd: async (id, cwd, cwdRepo) => {
      const record = threadRecords.get(id);
      if (!record) return undefined;
      // The hint is written with the directory, so an absent one clears it.
      const thread = { ...record.thread, cwd, cwdRepo };
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
    eventsAfterPage: async (id, sequence, limit) => {
      const page = events
        .filter((event) => event.threadId === id && event.sequence > sequence)
        .slice(0, limit);
      const last = page.at(-1);
      return {
        events: page,
        ...(last === undefined ? {} : { nextSequence: last.sequence }),
      };
    },
    setResult: async (id, result) => {
      const record = threadRecords.get(id);
      if (record === undefined) return;
      threadRecords.set(id, {
        ...record,
        thread: { ...record.thread, result },
      });
    },
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
      credentials: credentialResolver(),
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

/**
 * The Git answers one scripted repository gives the probe. `status` is the whole
 * `git status --porcelain=v2 --branch` document, headers included, so a case
 * states the exact bytes Git prints rather than an interpretation of them.
 */
export type FakeGitProbe = {
  /** `git status --porcelain=v2 --branch`, whole records as Git prints them. */
  readonly status?: string;
  readonly operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  readonly shallow?: boolean;
  readonly stash?: number;
  /** How many submodules the repository declares; the fact prints only then. */
  readonly submodules?: number;
  readonly worktree?: boolean;
  /** The short commit the probe reads while HEAD is detached. */
  readonly short?: string;
  /** What `git config --get remote.origin.url` answers. */
  readonly origin?: string;
};

/** One repository the fake sandbox holds, with the output git returns for it. */
export type FakeRepository = {
  readonly path: string;
  /** `git status --porcelain`, which the workspace changes view reads. */
  readonly status?: string;
  readonly diff?: string;
  /** The answers this repository gives the Git probe and the repository hint. */
  readonly git?: FakeGitProbe;
};

export type FakeSandboxOptions = {
  readonly root?: string;
  readonly id?: string;
  readonly entries?: readonly FakeSandboxEntry[];
  /** `git status --porcelain` of the repository at the workspace root. */
  readonly status?: string;
  readonly diff?: string;
  /** The Git probe answers of the repository at the workspace root. */
  readonly git?: FakeGitProbe;
  /** Repositories to discover, each by its workspace-relative root; `''` is the
   * workspace root. */
  readonly repositories?: readonly FakeRepository[];
  /**
   * Workspace-relative directories that read as inside the root but resolve
   * outside it, as a symbolic link does: the physical probe answers `outside`.
   */
  readonly escapes?: readonly string[];
};

/**
 * A deterministic stand-in for a leased sandbox that answers the exact command
 * shapes the workspace file rules issue, so their behavior can be observed
 * without a real VM:
 *
 * - `sh -c '<kind test>' sh <absolute path>` reports directory/file/missing;
 * - `sh -c '<scan>' entries <deep|shallow> <root>` lists the tree's typed
 *   entries and the root kind in one framed stream;
 * - `sh -c '<rules>' ignores <deep|shallow> <root> <ancestors...>` dumps every
 *   applicable `.gitignore` in one framed stream;
 * - `find <root> ( -name .git ) -prune -print` finds each scripted repository;
 * - `sh -c '<kind test>' sh <absolute path>` reports directory/file/missing;
 * - `sh -c '<git probe>' git-probe <absolute path>` answers the labeled Git
 *   facts and the repository's scripted porcelain-v2 status, or `repo false`;
 * - `sh -c '<hint>' git-hint <absolute path>` reports the repository hint of a
 *   directory whose own root holds a `.git`;
 * - `wc -c <absolute paths>` reports each file's byte size;
 * - `head -c <n> -- <path>` returns the first `n` bytes of the file;
 * - `git -C <root> status --porcelain` fails for a root without a repository;
 * - `git config --global <key> <value>` succeeds and is recorded;
 * - any other `sh -c <script>` succeeds as the workspace's own shell helper;
 * - `diff(input)` returns the diff of the repository `input.cwd` names;
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

  // A scripted `status` is the workspace-root repository; `repositories` names
  // the rest. Every repository root is a directory in the workspace.
  const repositories = new Map<string, FakeRepository>();
  for (const repository of [
    ...(options.status === undefined
      ? []
      : [
          {
            path: '',
            status: options.status,
            diff: options.diff,
            git: options.git,
          },
        ]),
    ...(options.repositories ?? []),
  ]) {
    const path = clean(repository.path);
    repositories.set(path, repository);
    directories.add(path);
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
    const marker = args.indexOf('-name');
    if (marker === -1 || args[marker + 1] !== '.git')
      throw new Error(`Unscripted sandbox command: find ${args.join(' ')}`);
    return [...repositories.keys()]
      .map((path) => absolute(path === '' ? '.git' : `${path}/.git`))
      .join('\n');
  };
  /**
   * The repository a directory lies in, found the way Git walks up: the
   * directory itself when it is a repository root, else its nearest ancestor.
   */
  const enclosing = (
    value: string,
  ):
    | { readonly root: string; readonly repository: FakeRepository }
    | undefined => {
    const target = relative(value);
    const parts = target === '' ? [''] : target.split('/');
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const root = parts.slice(0, depth).join('/');
      const repository = repositories.get(root);
      if (repository !== undefined) return { root, repository };
    }
    return undefined;
  };
  const operationMarkers = {
    rebase: 'REBASE_HEAD',
    'cherry-pick': 'CHERRY_PICK_HEAD',
    revert: 'REVERT_HEAD',
    merge: 'MERGE_HEAD',
    bisect: 'BISECT_LOG',
  } as const;
  /** The one-round-trip Git probe, in the shape the host's script prints it. */
  const gitProbe = (value: string): string => {
    const found = enclosing(value);
    if (found === undefined) return 'repo false';
    const facts = found.repository.git ?? {};
    const dot = absolute(found.root === '' ? '.git' : `${found.root}/.git`);
    const lines = [
      'repo true',
      `top ${absolute(found.root)}`,
      `gitdir ${facts.worktree === true ? `${dot}/worktrees/wt` : dot}`,
      `commondir ${dot}`,
      `shallow ${String(facts.shallow === true)}`,
    ];
    if (facts.short !== undefined) lines.push(`short ${facts.short}`);
    if (facts.operation !== undefined)
      lines.push(`operation ${operationMarkers[facts.operation]}`);
    lines.push(`stash ${String(facts.stash ?? 0)}`);
    // The host's script reads the recursive listing only when the repository
    // declares submodules, so the scripted answer prints the fact only then.
    if (facts.submodules !== undefined)
      lines.push(`submodules ${String(facts.submodules)}`);
    if (facts.origin !== undefined) lines.push(`origin ${facts.origin}`);
    lines.push('status', facts.status ?? '');
    return lines.join('\n');
  };
  /**
   * The repository hint: a directory whose own root holds a `.git` marker, and
   * the `origin` of the repository that marker belongs to. A scripted
   * repository holds one, exactly as the `find` above reports it.
   */
  const gitHint = (value: string): string => {
    const target = relative(value);
    const marker = target === '' ? '.git' : `${target}/.git`;
    if (!repositories.has(target) && kindOf(marker) === 'missing') return '';
    const origin = repositories.get(target)?.git?.origin;
    return `present\n${origin === undefined ? '' : `${origin}\n`}`;
  };
  /** The lines a shell `read` loop sees: split on newlines, final newline silent. */
  const shellLines = (content: string): readonly string[] => {
    const parts = content.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const dump = (
    label: 'entries' | 'ignores',
    deep: boolean,
    target: string,
    ancestors: readonly string[],
  ): string => {
    const lines: string[] = [];
    const content = (file: string): readonly string[] =>
      shellLines(files.get(relative(file)) ?? '').map((line) => `+${line}`);
    if (label === 'entries') {
      const kind = kindOf(target);
      lines.push(`K ${kind}`);
      if (kind !== 'directory') return lines.join('\n');
      const base = relative(target);
      for (const value of [...directories, ...files.keys()]) {
        const distance = depth(value, base);
        if (distance === undefined || (!deep && distance > 1)) continue;
        lines.push(`${directories.has(value) ? 'D' : 'F'} ${absolute(value)}`);
      }
      return lines.join('\n');
    }
    if (kindOf(target) !== 'directory') return '';
    for (const dir of ancestors) {
      const key = relative(dir);
      if (!files.has(key === '' ? '.gitignore' : `${key}/.gitignore`)) continue;
      lines.push(`A ${dir}`, ...content(`${dir}/.gitignore`));
    }
    if (!deep) return lines.join('\n');
    for (const key of files.keys()) {
      if (key !== '.gitignore' && !key.endsWith('/.gitignore')) continue;
      if (!under(key, relative(target))) continue;
      lines.push(`N ${absolute(key)}`, ...content(key));
    }
    return lines.join('\n');
  };
  const exec = async (input: SandboxExecInput): Promise<SandboxExecResult> => {
    execs.push(input);
    const [command, ...args] = input.cmd;
    // The path test passes a positional argument; a shell helper does not.
    if (command === 'sh') {
      const label = args[2];
      if (label === 'entries' || label === 'ignores')
        return ok(
          dump(label, args[3] === 'deep', args[4] ?? root, args.slice(5)),
        );
      if (label === 'git-probe') return ok(gitProbe(args[3] ?? root));
      if (label === 'git-hint') return ok(gitHint(args[3] ?? root));
      // The physical probe: a path the scripted workspace declares as escaping
      // resolves outside the root, and every other path resolves inside it.
      if (label === 'cwd-physical')
        return ok(
          (options.escapes ?? []).includes(relative(args[4] ?? root))
            ? 'outside'
            : 'inside',
        );
      return ok(args.length > 2 ? kindOf(args.at(-1) ?? root) : '');
    }
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
    if (command === 'git' && args.includes('status')) {
      const path = relative(args[0] === '-C' ? (args[1] ?? root) : root);
      const repository = repositories.get(path);
      return repository === undefined
        ? bytesResult(new Uint8Array(), 128)
        : ok(repository.status ?? '');
    }
    if (command === 'git' && args[0] === 'config') return ok('');
    throw new Error(`Unscripted sandbox command: ${input.cmd.join(' ')}`);
  };

  return {
    id: options.id ?? 'vm-1',
    root,
    exec,
    diff: async (input?: SandboxDiffInput) => {
      diffs.push(input);
      return repositories.get(relative(input?.cwd ?? root))?.diff ?? '';
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
