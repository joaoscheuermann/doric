import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { listSandboxRepos, type Sandbox, workspacePathKind } from 'sandbox';

import { CONTENT_LIMIT_BYTES, readProjectFile } from './files.js';

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';
export interface FileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly status: ChangeStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}
export interface RepositoryChanges {
  readonly path: string;
  readonly changes: readonly FileChange[];
  readonly added: number;
  readonly removed: number;
}
export interface FileDiff extends FileChange {
  readonly repository: string;
  readonly original: string;
  readonly modified: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

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

const under = (base: string, value: string) =>
  base === '' || value === base || value.startsWith(`${base}/`);

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
