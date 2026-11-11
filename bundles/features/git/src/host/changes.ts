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

  return { status: 'read', ...fileText(result.stdoutBytes) };
};

/** Bounded bytes as text: truncated past the cap, and empty when binary. */
const fileText = (bytes: Uint8Array) => {
  const truncated = bytes.byteLength > CONTENT_LIMIT_BYTES;
  const binary = bytes.includes(0);
  const content = binary
    ? ''
    : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8');
  return { content, truncated, binary };
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

/** Whether `value` is `base` or lies inside it; `''` holds every path. */
export const under = (base: string, value: string): boolean =>
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

/**
 * HEAD's copy of `$2` in the repository `$1`, bounded to `$3` bytes, in one
 * exec: nothing when the branch is unborn or HEAD lacks the path, otherwise
 * the blob's size on one line followed by its bytes. HEAD resolves as
 * `readHead` resolves it, exiting 4 where that throws; 5 is a failed tree read
 * and 6 a path HEAD holds as something other than a file.
 */
const ORIGINAL_SCRIPT = [
  'cwd=$1',
  'path=$2',
  'limit=$3',
  'if ! head=$(git -C "$cwd" rev-parse --verify HEAD 2>/dev/null); then',
  '  ref=$(git -C "$cwd" symbolic-ref -q HEAD) || exit 4',
  '  git -C "$cwd" show-ref --verify --quiet "$ref"',
  '  [ "$?" -eq 1 ] || exit 4',
  '  exit 0',
  'fi',
  'tree=$(git --literal-pathspecs -C "$cwd" ls-tree --long "$head" -- "$path") || exit 5',
  '[ -n "$tree" ] || exit 0',
  // The first four fields are the mode, type, object and size; the path
  // follows a tab, so splitting never reaches it before them.
  'set -f',
  'set -- $tree',
  '[ "$2" = blob ] || exit 6',
  'printf "%s\\n" "$4"',
  'git -C "$cwd" cat-file blob "$3" | head -c "$limit"',
].join('\n');

/** Reads HEAD's bytes of one path, bounded; empty when HEAD has none. */
const readOriginal = async (
  sandbox: Sandbox,
  cwd: string,
  path: string,
): Promise<Uint8Array> => {
  const result = await sandbox.exec({
    cmd: [
      'sh',
      '-c',
      ORIGINAL_SCRIPT,
      'sh',
      cwd,
      path,
      String(CONTENT_LIMIT_BYTES + 1),
    ],
  });
  if (result.exitCode === 4) throw new Error('Could not read repository HEAD.');
  if (result.exitCode === 6) throw new Error('The original is not a file.');
  if (result.exitCode !== 0) throw new Error('Could not read original file.');
  const bytes = result.stdoutBytes;
  if (bytes.byteLength === 0) return new Uint8Array();
  const header = bytes.indexOf(0x0a);
  const size = Number(Buffer.from(bytes.subarray(0, header)).toString('utf8'));
  const blob = bytes.subarray(header + 1);
  // A pipeline's last exit alone cannot prove the blob was read. Check its
  // immutable tree size too, including the extra byte used to mark truncation.
  if (
    header < 1 ||
    !Number.isInteger(size) ||
    blob.byteLength !== Math.min(size, CONTENT_LIMIT_BYTES + 1)
  )
    throw new Error('Could not read original file.');
  return blob;
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

const NUMSTAT = ['--numstat', '-z', '--no-ext-diff', '--no-textconv'];

/**
 * Git's numstat of each named path against empty, from inside the repository
 * `$1`: one `git diff --no-index` per path, all in one exec. A path that does
 * not exist, or a symbolic link whose target does not, adds nothing. Exit 1 is
 * Git's "the files differ" (and its answer for a directory, which prints no
 * count); anything above it fails the read.
 */
const ADDED_LINES_SCRIPT = [
  'cd -- "$1" || exit 2',
  'shift',
  'for path in "$@"; do',
  '  [ -e "$path" ] || continue',
  `  git diff ${NUMSTAT.join(' ')} --no-index -- /dev/null "$path"`,
  '  code=$?',
  '  [ "$code" -le 1 ] || exit "$code"',
  'done',
  'exit 0',
].join('\n');

/**
 * The argument bytes one exec carries, well under the smallest `ARG_MAX` Linux
 * allows, so a huge untracked set splits into a few execs instead of failing.
 */
const ARGUMENT_BYTES = 96 * 1024;

/** Paths grouped so no group's arguments exceed `ARGUMENT_BYTES`. */
const batches = (paths: readonly string[]): readonly string[][] => {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    // Each argument also costs its terminator and its pointer.
    const size = Buffer.byteLength(path) + 1 + 8;
    if (group.length > 0 && bytes + size > ARGUMENT_BYTES) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(path);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
};

/** Lines each path adds compared with empty, a constant number of execs. */
const readAddedTotals = async (
  sandbox: Sandbox,
  cwd: string,
  paths: readonly string[],
) => {
  const totals = { added: 0, removed: 0 };
  for (const batch of batches(paths)) {
    const result = await sandbox.exec({
      cmd: ['sh', '-c', ADDED_LINES_SCRIPT, 'sh', cwd, ...batch],
    });
    if (result.exitCode !== 0)
      throw new Error('Could not read added line counts.');
    // Each path's records end in NUL, so the joined output parses as one.
    const count = lineTotals(result.stdout);
    totals.added += count.added;
    totals.removed += count.removed;
  }
  return totals;
};

const readLineTotals = async (
  sandbox: Sandbox,
  repository: string,
  changes: readonly FileChange[],
) => {
  if (changes.length === 0) return { added: 0, removed: 0 };
  const cwd = repository || sandbox.root;
  const head = await readHead(sandbox, cwd);
  const tracked = async () => {
    if (head === undefined) return { added: 0, removed: 0 };
    const result = await sandbox.exec({
      cmd: ['git', '-C', cwd, 'diff', ...NUMSTAT, '--find-renames', head, '--'],
    });
    if (result.exitCode !== 0)
      throw new Error('Could not read changed line counts.');
    return lineTotals(
      result.stdout,
      new Set(
        changes.flatMap((change) => [
          change.path,
          ...(change.originalPath ? [change.originalPath] : []),
        ]),
      ),
    );
  };
  // Git's tracked diff omits untracked files. For an unborn branch all working
  // files compare to empty, including staged additions. Return counts, not bodies.
  const [changed, added] = await Promise.all([
    tracked(),
    readAddedTotals(
      sandbox,
      cwd,
      changes
        .filter((change) => head === undefined || change.status === 'untracked')
        .map((change) => change.path),
    ),
  ]);
  return {
    added: changed.added + added.added,
    removed: changed.removed + added.removed,
  };
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

/**
 * `git status` of a repository in one exec: `$1` is the workspace root, `$2`
 * the count of the repository path's parts that follow, and the arguments
 * after them go to `git status`. It first proves the path is a repository the
 * workspace's discovery (`listSandboxRepos`) lists, without walking the
 * workspace: the directory carries a `.git` entry, every directory on the way
 * down from the root is a real directory rather than a link, and none of them
 * carries a `.git` entry, as discovery keeps only the outermost repository.
 * Exit 3 means the path names no such repository.
 */
const REPOSITORY_STATUS_SCRIPT = [
  'marked() { [ -e "$1/.git" ] || [ -L "$1/.git" ]; }',
  'dir=$1',
  'parts=$2',
  'shift 2',
  '[ -d "$dir" ] || exit 3',
  'while [ "$parts" -gt 0 ]; do',
  '  marked "$dir" && exit 3',
  '  dir=$dir/$1',
  '  shift',
  '  parts=$((parts - 1))',
  '  { [ -d "$dir" ] && [ ! -L "$dir" ]; } || exit 3',
  'done',
  'marked "$dir" || exit 3',
  'exec git --no-optional-locks --literal-pathspecs -C "$dir" status --porcelain=v1 -z "$@"',
].join('\n');

/** A repository path as discovery spells it: no empty, `.` or `..` part. */
const repositoryPath = (repository: string): boolean =>
  repository === '' ||
  repository
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');

/** The repository's status records, or `undefined` when it is no repository. */
const readStatus = async (
  sandbox: Sandbox,
  repository: string,
  args: readonly string[],
): Promise<readonly FileChange[] | undefined> => {
  const result = await sandbox.exec({
    cmd: [
      'sh',
      '-c',
      REPOSITORY_STATUS_SCRIPT,
      'sh',
      sandbox.root,
      ...(repository === ''
        ? ['0']
        : [String(repository.split('/').length), ...repository.split('/')]),
      ...args,
    ],
  });
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0)
    throw new Error('Could not read repository changes.');
  return parseChanges(result.stdout);
};

/** Whether a record could be one side of a rename the whole status pairs. */
const pairable = (change: FileChange): boolean =>
  [change.indexStatus, change.worktreeStatus].some(
    (code) => code === 'A' || code === 'D',
  );

/**
 * The change the repository's whole status reports first for `path`, read
 * through a status limited to that path. Tracked records come before untracked
 * ones, so a tracked record wins. A limited status cannot pair a rename whose
 * other side lies outside the path, so a record that could be one side of a
 * rename (an addition or a deletion) is settled by the tracked part of the
 * whole status, which pairs renames without walking untracked files.
 */
const readChange = async (
  sandbox: Sandbox,
  repository: string,
  path: string,
): Promise<FileChange | undefined> => {
  const limited = await readStatus(sandbox, repository, [
    '--untracked-files=all',
    '--',
    path,
  ]);
  const own = limited?.filter((change) => change.path === path) ?? [];
  const untracked = own.find((change) => change.status === 'untracked');
  const tracked = own.find((change) => change.status !== 'untracked');
  if (tracked === undefined || !pairable(tracked)) return tracked ?? untracked;
  const whole = await readStatus(sandbox, repository, ['--untracked-files=no']);
  return whole?.find((record) => record.path === path) ?? untracked;
};

/**
 * The working file's bytes, bounded to `$2`, in one exec. Exit 3 means nothing
 * is there; a directory or other non-file exits 4, as the bounded read refuses
 * it.
 */
const WORKING_SCRIPT = [
  'if [ -d "$1" ]; then exit 4',
  'elif [ -f "$1" ]; then exec head -c "$2" -- "$1"',
  'elif [ -e "$1" ]; then exit 4',
  'else exit 3',
  'fi',
].join('\n');

/** The working file's bytes; `undefined` when it is missing. */
const readWorking = async (
  sandbox: Sandbox,
  path: string,
): Promise<Uint8Array | undefined> => {
  const result = await sandbox.exec({
    cmd: [
      'sh',
      '-c',
      WORKING_SCRIPT,
      'sh',
      path,
      String(CONTENT_LIMIT_BYTES + 1),
    ],
  });
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0) throw new Error('Could not read changed file.');
  return result.stdoutBytes;
};

/** A settled read, so a read nobody needs never rejects unobserved. */
const settle = <T>(read: Promise<T>) =>
  read.then(
    (value) => () => value,
    (error: unknown) => (): T => {
      throw error;
    },
  );

/**
 * Reads HEAD against the current working file, including untracked/deleted
 * files. The repository is checked and its status for the path read in one
 * exec, with no workspace-wide discovery; the working file and HEAD's copy of
 * the path are read alongside it, since neither depends on the status, and
 * only a rename reads HEAD again, at the path it came from.
 */
export const readProjectFileDiff = async (
  sandbox: Sandbox,
  repository: string,
  path: string,
): Promise<FileDiff | undefined> => {
  if (!repositoryPath(repository)) return undefined;
  const cwd = repository || sandbox.root;
  const [change, working, head] = await Promise.all([
    readChange(sandbox, repository, path),
    settle(readWorking(sandbox, posix.join(repository, path))),
    settle(readOriginal(sandbox, cwd, path)),
  ]);
  // No such repository, or the path is unchanged in it.
  if (change === undefined) return undefined;
  const originalPath = change.originalPath ?? path;
  const bytes =
    originalPath === path
      ? head()
      : await readOriginal(sandbox, cwd, originalPath);
  const after = working();
  const text = after === undefined ? undefined : fileText(after);
  const binary = bytes.includes(0) || text?.binary === true;
  return {
    ...change,
    repository,
    original: binary
      ? ''
      : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8'),
    modified: binary ? '' : (text?.content ?? ''),
    binary,
    truncated:
      bytes.byteLength > CONTENT_LIMIT_BYTES || text?.truncated === true,
  };
};
