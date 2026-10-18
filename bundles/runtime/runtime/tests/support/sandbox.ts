import { Buffer } from 'node:buffer';

import {
  defineMethod,
  defineService,
  type ServiceDefinition,
} from 'bundle/contracts';
import type {
  Sandbox,
  SandboxDiffInput,
  SandboxExecInput,
  SandboxExecResult,
  WorkspacePathKind,
} from 'sandbox';
import type { SandboxLease } from 'sandpool';

import { SandboxV1, sandboxMethods } from '../../src/contracts/sandbox.js';

/*
 * A scripted sandbox and a fake `sandbox/v1` provider for the runtime's
 * domain tests (design 57 §13.2: helpers/workspace.ts → tests/support). The
 * scripted sandbox is agents/doric's fake, moved verbatim.
 */

/** What the fake provider saw, for the cases that assert a lease's lifecycle. */
export interface SandboxRecord {
  /** Identities the runtime acquired, in order. */
  readonly acquired: string[];
  /** Identities the runtime discarded, in order. */
  readonly discarded: string[];
  /** How many leases were released. */
  released: number;
}

export interface SandboxProviderOptions {
  /** The sandbox every acquisition answers; `{ id: 'vm-1' }` by default. */
  readonly sandbox?: Sandbox;
  /** Replaces the acquisition, for cases that hold or fail it. */
  readonly acquire?: (input: {
    readonly identity: string;
    readonly signal?: AbortSignal;
  }) => Promise<SandboxLease>;
  readonly release?: () => void | Promise<void>;
  readonly discard?: (identity: string) => Promise<void>;
}

/** The minimal sandbox a case that never touches files leases. */
export const sandbox = { id: 'vm-1', root: '/workspace' } as unknown as Sandbox;

/** A fake `sandbox/v1`: one sandbox per acquisition, released on request. */
export const sandboxProvider = (
  options: SandboxProviderOptions = {},
): {
  readonly definition: ServiceDefinition;
  readonly record: SandboxRecord;
} => {
  const record: SandboxRecord = { acquired: [], discarded: [], released: 0 };
  const environment = options.sandbox ?? sandbox;
  const definition = defineService(SandboxV1, {
    describe: defineMethod({
      ...sandboxMethods.describe,
      execute: async () => ({ provider: 'docker', durableWorkspace: true }),
    }),
    acquire: defineMethod({
      ...sandboxMethods.acquire,
      execute: async (input) => {
        record.acquired.push(input.identity);
        if (options.acquire !== undefined) return options.acquire(input);
        return {
          sandbox: environment,
          release: async () => {
            record.released += 1;
            await options.release?.();
          },
        } as unknown as SandboxLease;
      },
    }),
    discard: defineMethod({
      ...sandboxMethods.discard,
      execute: async (identity) => {
        record.discarded.push(identity);
        await options.discard?.(identity);
      },
    }),
    machines: defineMethod({
      ...sandboxMethods.machines,
      execute: async () => [],
    }),
    machine: defineMethod({
      ...sandboxMethods.machine,
      execute: async () => undefined,
    }),
  });

  return { definition, record };
};

/** One scripted workspace entry; a missing `content` marks an empty directory. */
export interface FakeSandboxEntry {
  readonly path: string;
  readonly content?: string;
}

/**
 * The Git answers one scripted repository gives the probe. `status` is the whole
 * `git status --porcelain=v2 --branch` document, headers included, so a case
 * states the exact bytes Git prints rather than an interpretation of them.
 */
export interface FakeGitProbe {
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
}

/** One repository the fake sandbox holds, with the output git returns for it. */
export interface FakeRepository {
  readonly path: string;
  /** `git status --porcelain`, which the workspace changes view reads. */
  readonly status?: string;
  readonly diff?: string;
  /** The answers this repository gives the Git probe and the repository hint. */
  readonly git?: FakeGitProbe;
}

export interface FakeSandboxOptions {
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
}

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
      // The lease-time validation of every Thread working directory: one
      // NUL-terminated record per path named after the root, `K` when it is
      // still a directory inside the root and `X` otherwise.
      if (label === 'cwd-validate')
        return ok(
          args
            .slice(4)
            .map((path) => {
              const escaped = (options.escapes ?? []).includes(relative(path));
              const kept = kindOf(path) === 'directory' && !escaped;
              return `${kept ? 'K' : 'X'} ${path}`;
            })
            .join('\0'),
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
