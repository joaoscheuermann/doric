// The Project's changes, diff and one file's comparison (stage 10, §3.8),
// moved from the runtime's provisional `file-changes.ts` and the
// `projectChanges` part of `files.ts`, with the bounded file read the
// comparison's working side uses.

import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import type {
  ChangeStatus,
  FileChange,
  FileDiff,
  ProjectChange,
  ProjectChangeSet,
  RepositoryChanges,
} from 'runtime/contracts';
import { listSandboxRepos, type Sandbox, workspacePathKind } from 'sandbox';

/** The largest text payload the content route returns. */
export const CONTENT_LIMIT_BYTES = 262_144;

export type ProjectFileRead =
  | { readonly status: 'escaped' | 'missing' | 'not_file' }
  | {
      readonly status: 'read';
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    };

/** Reads one workspace file as bounded UTF-8 text, never a mangled binary. */
export const readProjectFile = async (
  sandbox: Sandbox,
  path: string,
): Promise<ProjectFileRead> => {
  const kind = await workspacePathKind(sandbox, path);

  if (kind === 'escaped') return { status: 'escaped' };
  if (kind === 'missing') return { status: 'missing' };
  if (kind !== 'file') return { status: 'not_file' };

  // One bounded read: ask for one byte past the cap so truncation is visible.
  const result = await sandbox.exec({
    cmd: ['head', '-c', String(CONTENT_LIMIT_BYTES + 1), '--', path],
  });

  if (result.exitCode !== 0) return { status: 'missing' };

  const bytes = result.stdoutBytes;
  const truncated = bytes.byteLength > CONTENT_LIMIT_BYTES;
  const binary = bytes.includes(0);
  const content = binary
    ? ''
    : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8');

  return { status: 'read', content, truncated, binary };
};

/**
 * The workspace's Git state, one entry per repository it holds: each repository's
 * tracked diff plus its own change list, including the untracked files. A `path`
 * scopes discovery to the repositories that path belongs to or holds, which is
 * how the renderer reads the changes view of one Thread's working directory; an
 * absent path names the workspace root, whose own repositories are all of them.
 * The changes list cannot come from `Sandbox.diff`, because a diff never contains
 * untracked files, so it is read through `exec` at the repository root; the diff
 * itself still goes through the `Sandbox` contract, scoped to that same root.
 * Discovery stops at each repository boundary, so a repository nested in another
 * is left to the outer one, exactly as Git reports it.
 */
export const projectChanges = async (
  sandbox: Sandbox,
  path = '',
): Promise<readonly ProjectChangeSet[]> => {
  const repos = await listSandboxRepos(sandbox);

  // A workspace root that is missing or not a directory holds no repository.
  if (repos.status !== 'listed') return [];

  const entries = await Promise.all(
    repos.repositories
      .filter(({ path: root }) => reachable(path, root))
      .map(async ({ path: root }): Promise<ProjectChangeSet | undefined> => {
        // `-C` sets the repository; the workspace root is git's own default.
        const cwd = root === '' ? sandbox.root : root;

        const status = await sandbox.exec({
          cmd: ['git', '-C', cwd, 'status', '--porcelain'],
        });

        // A non-zero exit means git refused to read this repository.
        if (status.exitCode !== 0) return undefined;

        return {
          path: root,
          diff: await sandbox.diff({ cwd }),
          changes: status.stdout.split('\n').flatMap((line) => {
            const change = parseChange(line);
            return change === undefined ? [] : [change];
          }),
        };
      }),
  );

  return entries.filter((entry) => entry !== undefined);
};

/**
 * Whether a repository belongs to the scope: the scope lies inside it, or it
 * lies inside the scope. An empty scope holds every repository, which keeps an
 * unscoped read the whole-workspace read it always was.
 */
const reachable = (scope: string, root: string): boolean =>
  scope === '' || under(scope, root) || under(root, scope);

const under = (base: string, value: string): boolean =>
  base === '' || value === base || value.startsWith(`${base}/`);

/** One porcelain line: two status characters, a space, then the path. */
const parseChange = (line: string): ProjectChange | undefined => {
  if (line.length < 4) return undefined;

  const code = line.slice(0, 2);
  const value = line.slice(3);

  if (value === '') return undefined;
  if (code === '??') return { path: value, status: 'untracked' };
  if (code.includes('R')) {
    const destination = value.includes(' -> ')
      ? value.split(' -> ').at(-1)
      : undefined;
    return destination === undefined
      ? undefined
      : { path: destination, status: 'renamed' };
  }
  if (code.includes('A')) return { path: value, status: 'added' };
  if (code.includes('D')) return { path: value, status: 'deleted' };

  return { path: value, status: 'modified' };
};

/** NUL porcelain preserves every character in names and pairs rename paths. */
const parseChanges = (text: string): readonly FileChange[] => {
  const records = text.split('\0');
  const changes: FileChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const code = record.slice(0, 2);
    const renamed = code.includes('R') || code.includes('C');
    const originalPath = renamed ? records[++index] : undefined;
    const untracked = code === '??';
    const conflicted = code.includes('U') || code === 'AA' || code === 'DD';
    const status: ChangeStatus = conflicted
      ? 'conflicted'
      : untracked
        ? 'untracked'
        : renamed
          ? 'renamed'
          : code.includes('D')
            ? 'deleted'
            : code.includes('A')
              ? 'added'
              : 'modified';
    changes.push({
      path: record.slice(3),
      ...(originalPath === undefined ? {} : { originalPath }),
      status,
      staged: !untracked && !code.startsWith(' '),
      unstaged: untracked || code[1] !== ' ',
      indexStatus: code[0] ?? ' ',
      worktreeStatus: code[1] ?? ' ',
    });
  }
  return changes;
};

const readChanges = async (sandbox: Sandbox, repository: string) => {
  const result = await sandbox.exec({
    cmd: [
      'git',
      '--no-optional-locks',
      '-C',
      repository || sandbox.root,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ],
  });
  if (result.exitCode !== 0)
    throw new Error('Could not read repository changes.');
  return parseChanges(result.stdout);
};

const readHead = async (
  sandbox: Sandbox,
  cwd: string,
): Promise<string | undefined> => {
  const head = await sandbox.exec({
    cmd: ['git', '-C', cwd, 'rev-parse', '--verify', 'HEAD'],
  });
  if (head.exitCode !== 0) {
    const symbolic = await sandbox.exec({
      cmd: ['git', '-C', cwd, 'symbolic-ref', '-q', 'HEAD'],
    });
    if (symbolic.exitCode !== 0)
      throw new Error('Could not read repository HEAD.');
    const branch = await sandbox.exec({
      cmd: [
        'git',
        '-C',
        cwd,
        'show-ref',
        '--verify',
        '--quiet',
        symbolic.stdout.trim(),
      ],
    });
    if (branch.exitCode === 1) return undefined;
    throw new Error('Could not read repository HEAD.');
  }
  return head.stdout.trim();
};

const readOriginal = async (
  sandbox: Sandbox,
  cwd: string,
  path: string,
): Promise<Uint8Array> => {
  const head = await readHead(sandbox, cwd);
  if (head === undefined) return new Uint8Array();
  const tree = await sandbox.exec({
    cmd: [
      'git',
      '--literal-pathspecs',
      '-C',
      cwd,
      'ls-tree',
      '-z',
      '--long',
      head,
      '--',
      path,
    ],
  });
  if (tree.exitCode !== 0) throw new Error('Could not read original file.');
  if (tree.stdout === '') return new Uint8Array();
  const blob = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t/.exec(tree.stdout);
  if (blob === null) throw new Error('The original is not a file.');
  const size = Number(blob[2]);
  const result = await sandbox.exec({
    cmd: [
      'sh',
      '-c',
      'git -C "$1" cat-file blob "$2" | head -c "$3"',
      'sh',
      cwd,
      blob[1] ?? '',
      String(CONTENT_LIMIT_BYTES + 1),
    ],
  });
  // A pipeline's last exit alone cannot prove the blob was read. Check its
  // immutable tree size too, including the extra byte used to mark truncation.
  if (
    result.exitCode !== 0 ||
    result.stdoutBytes.byteLength !== Math.min(size, CONTENT_LIMIT_BYTES + 1)
  )
    throw new Error('Could not read original file.');
  return result.stdoutBytes;
};

/** NUL numstat includes two extra path records for a rename. Binary counts are '-'. */
const lineTotals = (text: string, paths?: ReadonlySet<string>) => {
  const records = text.split('\0');
  let added = 0;
  let removed = 0;
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(records[index] ?? '');
    if (!match) continue;
    let path = match[3] ?? '';
    let originalPath = path;
    if (path === '') {
      originalPath = records[++index] ?? '';
      path = records[++index] ?? '';
    }
    if (paths && !paths.has(path) && !paths.has(originalPath)) continue;
    added += match[1] === '-' ? 0 : Number(match[1]);
    removed += match[2] === '-' ? 0 : Number(match[2]);
  }
  return { added, removed };
};

const readLineTotals = async (
  sandbox: Sandbox,
  repository: string,
  changes: readonly FileChange[],
) => {
  const totals = { added: 0, removed: 0 };
  if (changes.length === 0) return totals;
  const cwd = repository || sandbox.root;
  const head = await readHead(sandbox, cwd);
  const diff = [
    'git',
    '-C',
    cwd,
    'diff',
    '--numstat',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
  ];
  if (head !== undefined) {
    const result = await sandbox.exec({
      cmd: [...diff, '--find-renames', head, '--'],
    });
    if (result.exitCode !== 0)
      throw new Error('Could not read changed line counts.');
    Object.assign(
      totals,
      lineTotals(
        result.stdout,
        new Set(
          changes.flatMap((change) => [
            change.path,
            ...(change.originalPath ? [change.originalPath] : []),
          ]),
        ),
      ),
    );
  }
  // Git's tracked diff omits untracked files. For an unborn branch all working
  // files compare to empty, including staged additions. Return counts, not bodies.
  for (const change of changes) {
    if (head !== undefined && change.status !== 'untracked') continue;
    if (
      (await workspacePathKind(
        sandbox,
        posix.join(repository, change.path),
      )) === 'missing'
    )
      continue;
    const result = await sandbox.exec({
      cmd: [...diff, '--no-index', '--', '/dev/null', change.path],
    });
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error('Could not read added line counts.');
    const count = lineTotals(result.stdout);
    totals.added += count.added;
    totals.removed += count.removed;
  }
  return totals;
};

/** Reads status and line counts; no file bodies or patches cross the boundary. */
export const readProjectChanges = async (
  sandbox: Sandbox,
  scope = '',
): Promise<readonly RepositoryChanges[]> => {
  const repos = await listSandboxRepos(sandbox);
  if (repos.status !== 'listed') return [];
  return Promise.all(
    repos.repositories
      .filter(({ path }) => under(scope, path) || under(path, scope))
      .map(async ({ path }) => {
        const changes = (await readChanges(sandbox, path)).filter(
          (change) =>
            under(scope, posix.join(path, change.path)) ||
            (change.originalPath !== undefined &&
              under(scope, posix.join(path, change.originalPath))),
        );
        return {
          path,
          changes,
          ...(await readLineTotals(sandbox, path, changes)),
        };
      }),
  );
};

/** Reads HEAD against the current working file, including untracked/deleted files. */
export const readProjectFileDiff = async (
  sandbox: Sandbox,
  repository: string,
  path: string,
): Promise<FileDiff | undefined> => {
  const repos = await listSandboxRepos(sandbox);
  if (
    repos.status !== 'listed' ||
    !repos.repositories.some((repo) => repo.path === repository)
  )
    return undefined;
  const change = (await readChanges(sandbox, repository)).find(
    (change) => change.path === path,
  );
  if (change === undefined) return undefined;
  const cwd = repository || sandbox.root;
  const originalPath = change.originalPath ?? path;
  const bytes = await readOriginal(sandbox, cwd, originalPath);
  const fullPath = posix.join(repository, path);
  const kind = await workspacePathKind(sandbox, fullPath);
  const after =
    kind === 'missing' ? undefined : await readProjectFile(sandbox, fullPath);
  if (after !== undefined && after.status !== 'read')
    throw new Error('Could not read changed file.');
  const binary = bytes.includes(0) || after?.binary === true;
  return {
    ...change,
    repository,
    original: binary
      ? ''
      : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8'),
    modified: binary ? '' : (after?.content ?? ''),
    binary,
    truncated:
      bytes.byteLength > CONTENT_LIMIT_BYTES || after?.truncated === true,
  };
};
