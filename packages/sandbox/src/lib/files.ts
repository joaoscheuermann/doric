import { posix as path } from 'node:path';

import type {
  SandboxEntry,
  SandboxListFailure,
  SandboxListInput,
  SandboxListResult,
  SandboxRepo,
  SandboxReposResult,
  SandboxTreeNode,
  SandboxTreeResult,
  WorkspacePathKind,
} from './types/files.js';
import type { Sandbox } from './types/sandbox.js';

/**
 * The one implementation of the workspace visibility rules: root confinement,
 * `.gitignore` handling with negation, hidden entries except `.agents`, and
 * directories-first alphabetical ordering. The `tree` tool and the host's file
 * routes both consume it, so neither can drift from the other.
 */

/** Hidden entries stay hidden except the agent skills directory. */
const HIDDEN_EXCEPTIONS = new Set(['.agents']);

/** `wc` argument batches stay well below the platform argument-list limit. */
const SIZE_BATCH = 256;

/**
 * The listing scan: `$1` is `deep` or `shallow`, `$2` the listed directory, and
 * remaining arguments are literal `find` predicates for invisible directories. One
 * `find` pass prints every entry the two old passes printed, and a shell loop
 * tags each line `D`irectory or `F`ile, so one round trip reports the root kind
 * (`K`) and every entry with its type. A failed scan prints no entry lines,
 * which is the empty listing the two-pass version produced.
 */
const ENTRIES_SCRIPT = String.raw`mode=$1
root=$2
shift 2
if [ -d "$root" ]; then
  printf 'K directory\n'
  if [ "$mode" = deep ]; then
    out=$(find "$root" \( -name .git "$@" \) -prune -o -type d -print -o -type f -print)
    status=$?
  else
    out=$(find "$root" -maxdepth 1 -name .git -prune -o -type d -print -o -type f -print)
    status=$?
  fi
  if [ "$status" = 0 ] && [ -n "$out" ]; then
    printf '%s\n' "$out" | while IFS= read -r item; do
      if [ -d "$item" ]; then
        printf 'D %s\n' "$item"
      else
        printf 'F %s\n' "$item"
      fi
    done
  fi
elif [ -f "$root" ]; then
  printf 'K file\n'
elif [ -e "$root" ]; then
  printf 'K other\n'
else
  printf 'K missing\n'
fi
`;

/**
 * The ignore rules: `$1` is `deep` or `shallow`, `$2` the listed directory,
 * `$3...` its ancestor directories. Every `.gitignore` the old code read one
 * round trip at a time is printed here as one stream: `A <dir>` opens an
 * ancestor's rules, `N <file>` a subtree file's, and each content line follows
 * prefixed with `+` so rules and framing can never collide. Each file is read
 * by the shell itself, so a workspace with many rule files costs no extra
 * process. A deep listing also reports directory paths as `D` records and scans
 * for `.gitignore` files, without transferring the files inside ignored trees.
 */
const IGNORES_SCRIPT = String.raw`mode=$1
root=$2
shift 2
if [ -d "$root" ]; then
  for dir do
    if [ -f "$dir/.gitignore" ]; then
      printf 'A %s\n' "$dir"
      while IFS= read -r line || [ -n "$line" ]; do
        printf '+%s\n' "$line"
      done 2>/dev/null < "$dir/.gitignore"
    fi
  done
  if [ "$mode" = deep ]; then
    find "$root" -name .git -prune -o -type d -print | sed 's/^/D /'
    out=$(find "$root" -name .git -prune -o -type f -name .gitignore -print)
    status=$?
    if [ "$status" = 0 ] && [ -n "$out" ]; then
      printf '%s\n' "$out" | while IFS= read -r file; do
        if [ -n "$file" ]; then
          printf 'N %s\n' "$file"
          while IFS= read -r line || [ -n "$line" ]; do
            printf '+%s\n' "$line"
          done 2>/dev/null < "$file"
        fi
      done
    fi
  fi
fi
`;

interface Entry {
  readonly path: string;
  readonly isDirectory: boolean;
}

interface IgnorePattern {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
}

/** One ignore pattern with its glob compiled once per listing. */
interface IgnoreMatcher {
  readonly base: string;
  readonly source: string;
  readonly directory: boolean;
  readonly negated: boolean;
  /** `undefined` when the pattern is not a glob and matches by equality. */
  readonly glob: RegExp | undefined;
}

/** Lists one workspace directory level, with sizes for its files. */
export const listSandboxDirectory = async (
  sandbox: Sandbox,
  input: SandboxListInput = {},
): Promise<SandboxListResult> => {
  const listing = await listVisible(sandbox, input, false);

  if ('status' in listing) {
    return listing;
  }

  const { root, entries } = listing;
  const sizes = await fileSizes(
    sandbox,
    entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
  );

  return {
    status: 'listed',
    path: root.relative,
    entries: ordered(entries).map((entry) =>
      entryResult(sandbox, entry, sizes),
    ),
  };
};

/** Lists a workspace directory recursively, so each directory carries children. */
export const listSandboxTree = async (
  sandbox: Sandbox,
  input: SandboxListInput = {},
): Promise<SandboxTreeResult> => {
  const listing = await listVisible(sandbox, input, true);

  if ('status' in listing) {
    return listing;
  }

  return {
    status: 'listed',
    path: listing.root.relative,
    entries: tree(sandbox, listing.root.path, listing.entries),
  };
};

/**
 * Discover directories and ignore rules first, then prune invisible directories
 * from the expensive typed file scan. Final filtering keeps the same rules for
 * files and for directories beyond the bounded prune argument budget.
 */
const listVisible = async (
  sandbox: Sandbox,
  input: SandboxListInput,
  deep: boolean,
): Promise<
  | {
      readonly root: { readonly path: string; readonly relative: string };
      readonly entries: readonly Entry[];
    }
  | SandboxListResult
> => {
  const gates = listable(sandbox, input);

  if ('status' in gates) {
    return gates;
  }

  const { root, excludes } = gates;
  const { ignores, directories } = await ignoreDump(
    sandbox,
    root.path,
    ancestorDirs(sandbox.root, root.path),
    deep,
  );
  const scan = await entryDump(
    sandbox,
    root.path,
    deep,
    prunedDirectories(root.path, directories, ignores),
  );

  if (scan.kind === 'missing') {
    return { status: 'missing' };
  }

  if (scan.kind !== 'directory') {
    return { status: 'not_directory' };
  }

  const name = path.basename(root.path);

  if (excludes.some((pattern) => pattern.test(name))) {
    return { status: 'excluded_root', name };
  }

  return {
    root,
    entries: visibleEntries(root.path, scan.entries, ignores, excludes),
  };
};

/**
 * The Git repositories in the workspace, found by the `.git` marker that sits at
 * every repository root — a directory for an ordinary clone, a file for a
 * submodule or a linked worktree. Each `.git` is pruned, so nothing inside it is
 * read, and the result stops at the outermost repository boundary: a repository
 * nested in another is left to the outer one, exactly as Git reports it, so a
 * nested repository's files are never listed twice.
 */
export const listSandboxRepos = async (
  sandbox: Sandbox,
): Promise<SandboxReposResult> => {
  const kind = await pathKind(sandbox, sandbox.root, sandbox.root);

  if (kind === 'missing') {
    return { status: 'missing' };
  }

  if (kind !== 'directory') {
    return { status: 'not_directory' };
  }

  const result = await sandbox.exec({
    cwd: sandbox.root,
    cmd: ['find', sandbox.root, '(', '-name', '.git', ')', '-prune', '-print'],
  });

  if (result.exitCode !== 0) {
    return { status: 'missing' };
  }

  return {
    status: 'listed',
    path: '',
    repositories: repositoryRoots(sandbox, lines(result.stdout)),
  };
};

/**
 * The repository roots the `.git` markers name, as workspace-relative paths,
 * sorted and reduced to the outermost of any nesting. An ancestor always sorts
 * before the paths under it, so one pass keeps each boundary and drops the
 * repositories found inside it.
 */
const repositoryRoots = (
  sandbox: Sandbox,
  markers: readonly string[],
): readonly SandboxRepo[] => {
  const roots = [
    ...new Set(
      markers.map((marker) =>
        relative(sandbox.root, path.dirname(normalize(marker))),
      ),
    ),
  ].sort();

  return roots.reduce<SandboxRepo[]>((kept, path) => {
    if (!kept.some((repo) => under(repo.path, path))) {
      kept.push({ path });
    }

    return kept;
  }, []);
};

/** Whether `path` is `root` itself or lies under it; the workspace root holds all. */
const under = (root: string, path: string): boolean =>
  root === '' || path === root || path.startsWith(`${root}/`);

/** Reports what a workspace-relative path is, without reading its content. */
export const workspacePathKind = async (
  sandbox: Sandbox,
  value = '',
): Promise<WorkspacePathKind | 'escaped'> => {
  const resolved = resolve(sandbox.root, value);

  if (typeof resolved === 'string') {
    return 'escaped';
  }

  return pathKind(sandbox, sandbox.root, resolved.path);
};

/** The resolved root plus the exclude patterns every listing shares. */
const listable = (
  sandbox: Sandbox,
  input: SandboxListInput,
):
  | {
      readonly root: { readonly path: string; readonly relative: string };
      readonly excludes: readonly RegExp[];
    }
  | SandboxListFailure => {
  const root = resolve(sandbox.root, input.path ?? '');

  if (typeof root === 'string') {
    return { status: 'escaped', message: root };
  }

  const excludes = compileExcludes(input.exclude ?? []);

  if (typeof excludes === 'string') {
    return { status: 'invalid_exclude', message: excludes };
  }

  return { root, excludes };
};

const entryResult = (
  sandbox: Sandbox,
  entry: Entry,
  sizes: ReadonlyMap<string, number>,
): SandboxEntry => {
  const size = entry.isDirectory ? undefined : sizes.get(entry.path);

  return {
    name: path.basename(entry.path),
    path: relative(sandbox.root, entry.path),
    type: entry.isDirectory ? 'directory' : 'file',
    ...(size === undefined ? {} : { size }),
  };
};

/** Groups the flat visible entries into the directory tree the tool renders. */
const tree = (
  sandbox: Sandbox,
  root: string,
  entries: readonly Entry[],
): readonly SandboxTreeNode[] => {
  const groups = new Map<string, Entry[]>();

  for (const entry of entries) {
    const parent = path.dirname(entry.path);
    const group = groups.get(parent);

    if (group === undefined) {
      groups.set(parent, [entry]);
    } else {
      group.push(entry);
    }
  }

  const build = (parent: string): readonly SandboxTreeNode[] =>
    ordered(groups.get(parent) ?? []).map((entry) => ({
      name: path.basename(entry.path),
      path: relative(sandbox.root, entry.path),
      type: entry.isDirectory ? ('directory' as const) : ('file' as const),
      ...(entry.isDirectory ? { children: build(entry.path) } : {}),
    }));

  return build(root);
};

const visibleEntries = (
  root: string,
  listed: readonly Entry[],
  ignores: readonly IgnorePattern[],
  excludes: readonly RegExp[],
): readonly Entry[] => {
  const ignored = ignoredWithin(root, ignores);

  return listed.filter(
    (entry) =>
      !(entry.isDirectory && entry.path === root) &&
      !isHidden(root, entry.path) &&
      !ignored(entry.path, entry.isDirectory) &&
      !isExcluded(entry.path, excludes),
  );
};

/**
 * Directories first, then files, both sorted by name the way the tool prints.
 * Names the accent-insensitive comparison finds equal stay in workspace-path
 * order, the order the listing held before it was sorted here.
 */
const ordered = (entries: readonly Entry[]): readonly Entry[] =>
  [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    const byName = path
      .basename(left.path)
      .localeCompare(path.basename(right.path), undefined, {
        sensitivity: 'accent',
      });

    if (byName !== 0) {
      return byName;
    }

    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

/** The root kind and typed entries one listing scan reports. */
interface Scan {
  readonly kind: WorkspacePathKind;
  readonly entries: readonly Entry[];
}

/**
 * Runs the one-pass listing script and reads its framed stream: a `K` record
 * for the root kind, then `D` and `F` records for the entries below it.
 */
const entryDump = async (
  sandbox: Sandbox,
  root: string,
  deep: boolean,
  pruned: readonly string[],
): Promise<Scan> => {
  const result = await sandbox.exec({
    cwd: sandbox.root,
    cmd: [
      'sh',
      '-c',
      ENTRIES_SCRIPT,
      'entries',
      deep ? 'deep' : 'shallow',
      root,
      ...pruned.flatMap((directory) => [
        '-o',
        '-path',
        directory.replace(/[\\*?[\]]/g, '\\$&'),
      ]),
    ],
  });

  let kind: WorkspacePathKind = 'missing';
  const entries: Entry[] = [];

  for (const line of lines(result.stdout)) {
    if (line.startsWith('K ')) {
      kind = parsePathKind(line.slice(2));
    } else if (line.startsWith('D ')) {
      entries.push({ path: normalize(line.slice(2)), isDirectory: true });
    } else if (line.startsWith('F ')) {
      entries.push({ path: normalize(line.slice(2)), isDirectory: false });
    }
  }

  return { kind, entries };
};

/** Byte sizes for the named files, measured in one command per batch. */
const fileSizes = async (
  sandbox: Sandbox,
  files: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  const sizes = new Map<string, number>();

  for (let index = 0; index < files.length; index += SIZE_BATCH) {
    const result = await sandbox.exec({
      cmd: ['wc', '-c', ...files.slice(index, index + SIZE_BATCH)],
    });

    if (result.exitCode !== 0) {
      continue;
    }

    for (const line of lines(result.stdout)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      const size = match?.[1];
      const file = match?.[2];

      if (size !== undefined && file !== undefined) {
        sizes.set(file, Number(size));
      }
    }
  }

  return sizes;
};

/**
 * Every `.gitignore` from the workspace root down to `dir`, inclusive. A pattern
 * applies to the directory that holds its file and everything below it, so the
 * ancestors of the listed directory are part of listing it.
 */
const ancestorDirs = (
  workspaceRoot: string,
  dir: string,
): readonly string[] => {
  const relative = path.relative(workspaceRoot, dir);
  const parts = relative === '' ? [] : relative.split('/');

  return [
    workspaceRoot,
    ...parts.map((_, index) =>
      path.join(workspaceRoot, ...parts.slice(0, index + 1)),
    ),
  ];
};

/**
 * The ignore rules one listing applies, in the order the old per-file reads
 * produced: each ancestor directory's rules from the workspace root down, then
 * every subtree `.gitignore` by path with the workspace's own among them. The
 * pattern bases carry where each rule applies; nothing is read twice here, the
 * stream simply names each file's rules once per source.
 */
const ignoreDump = async (
  sandbox: Sandbox,
  root: string,
  dirs: readonly string[],
  deep: boolean,
): Promise<{
  readonly ignores: readonly IgnorePattern[];
  readonly directories: readonly string[];
}> => {
  const result = await sandbox.exec({
    cwd: sandbox.root,
    cmd: [
      'sh',
      '-c',
      IGNORES_SCRIPT,
      'ignores',
      deep ? 'deep' : 'shallow',
      root,
      ...dirs,
    ],
  });

  return {
    ignores: parseIgnoreDump(result.stdout),
    directories: lines(result.stdout)
      .filter((line) => line.startsWith('D '))
      .map((line) => normalize(line.slice(2))),
  };
};

/** Only outermost invisible directories need prune arguments. Keep argv bounded;
 * omitted paths still receive the ordinary visibility filter after the scan. */
const prunedDirectories = (
  root: string,
  directories: readonly string[],
  ignores: readonly IgnorePattern[],
): readonly string[] => {
  const ignored = ignoredWithin(root, ignores);
  const pruned: string[] = [];
  const skipped = new Set<string>();
  let budget = 32768;
  for (const directory of [...directories].sort()) {
    if (
      directory === root ||
      ancestors(root, directory).some((parent) => skipped.has(parent))
    )
      continue;
    if (!isHidden(root, directory) && !ignored(directory, true)) continue;
    skipped.add(directory);
    if (directory.length > budget) continue;
    pruned.push(directory);
    budget -= directory.length;
  }
  return pruned;
};

/** Reads the framed ignore stream back into the patterns each rule holds. */
const parseIgnoreDump = (stdout: string): readonly IgnorePattern[] => {
  const ancestors: IgnorePattern[] = [];
  const nested: { key: string; patterns: readonly IgnorePattern[] }[] = [];
  let source: { readonly base: string; readonly key: string } | undefined;
  let text: string[] = [];

  const flush = (): void => {
    const block = source;
    source = undefined;
    const content = text.join('\n');
    text = [];

    if (block === undefined) {
      return;
    }

    const patterns = parseIgnores(block.base, content);

    if (block.key === '') {
      ancestors.push(...patterns);
    } else {
      nested.push({ key: block.key, patterns });
    }
  };

  for (const line of lines(stdout)) {
    if (line.startsWith('+') && source !== undefined) {
      text.push(line.slice(1));
    } else {
      flush();

      if (line.startsWith('A ')) {
        source = { base: line.slice(2), key: '' };
      } else if (line.startsWith('N ')) {
        const file = normalize(line.slice(2));
        source = { base: path.dirname(file), key: file };
      }
    }
  }

  flush();

  nested.sort((left, right) =>
    left.key === right.key ? 0 : left.key < right.key ? -1 : 1,
  );

  return [...ancestors, ...nested.flatMap((block) => block.patterns)];
};

const parseIgnores = (base: string, text: string): readonly IgnorePattern[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => ({
      base,
      pattern: line.startsWith('!') ? line.slice(1) : line,
      negated: line.startsWith('!'),
    }))
    .filter((ignore) => ignore.pattern !== '');

const isHidden = (root: string, fullPath: string): boolean =>
  path
    .relative(root, fullPath)
    .split('/')
    .some((part) => part.startsWith('.') && !HIDDEN_EXCEPTIONS.has(part));

/**
 * Whether a path is ignored inside `root`: the rule every ancestor directory
 * resolves to, or the path's own last matching rule. Rules are compiled once
 * per listing and bucketed by base, so each path only meets the rules of the
 * directories that hold it — in the chain from the path up — and each directory
 * is decided once, whatever the listing's depth.
 */
const ignoredWithin = (
  root: string,
  ignores: readonly IgnorePattern[],
): ((fullPath: string, isDirectory: boolean) => boolean) => {
  const byBase = new Map<
    string,
    { readonly matcher: IgnoreMatcher; readonly order: number }[]
  >();

  ignores.forEach((ignore, order) => {
    const matcher = compileIgnore(ignore);
    const bucket = byBase.get(matcher.base);
    const rule = { matcher, order };

    if (bucket === undefined) {
      byBase.set(matcher.base, [rule]);
    } else {
      bucket.push(rule);
    }
  });

  const decided = new Map<string, boolean>();

  const status = (fullPath: string, isDirectory: boolean): boolean => {
    const cached = decided.get(fullPath);

    if (cached !== undefined) {
      return cached;
    }

    let ignored = false;
    let decidedBy = -1;

    for (let base = fullPath; ; base = path.dirname(base)) {
      for (const { matcher, order } of byBase.get(base) ?? []) {
        if (order <= decidedBy || (matcher.directory && !isDirectory)) {
          continue;
        }

        const relative = path.relative(matcher.base, fullPath);
        const name = path.basename(fullPath);
        const matched =
          matcher.glob === undefined
            ? relative === matcher.source || name === matcher.source
            : matcher.glob.test(relative) || matcher.glob.test(name);

        if (matched) {
          ignored = !matcher.negated;
          decidedBy = order;
        }
      }

      const parent = path.dirname(base);

      if (parent === base) {
        break;
      }
    }

    decided.set(fullPath, ignored);

    return ignored;
  };

  return (fullPath, isDirectory) =>
    ancestors(root, fullPath).some((ancestor) => status(ancestor, true)) ||
    status(fullPath, isDirectory);
};

/** Compiles one ignore pattern to the matcher its entries test against. */
const compileIgnore = (ignore: IgnorePattern): IgnoreMatcher => {
  const directory = ignore.pattern.endsWith('/');
  const source = directory ? ignore.pattern.slice(0, -1) : ignore.pattern;
  const glob = compileGlob(source);

  return {
    base: ignore.base,
    source,
    directory,
    negated: ignore.negated,
    glob: glob instanceof RegExp ? glob : undefined,
  };
};

const ancestors = (root: string, fullPath: string): readonly string[] => {
  const values: string[] = [];
  let current = path.dirname(fullPath);

  while (contains(root, current) && current !== root) {
    values.unshift(current);

    current = path.dirname(current);
  }

  return values;
};

const isExcluded = (fullPath: string, excludes: readonly RegExp[]): boolean => {
  const name = path.basename(fullPath);

  return excludes.some(
    (pattern) => pattern.test(name) || pattern.test(fullPath),
  );
};

const compileExcludes = (
  patterns: readonly string[],
): readonly RegExp[] | string => {
  const compiled: RegExp[] = [];

  for (const pattern of patterns) {
    const glob = compileGlob(pattern);

    if (typeof glob === 'string') {
      return glob;
    }

    compiled.push(glob);
  }

  return compiled;
};

const compileGlob = (pattern: string): RegExp | string => {
  if (pattern.includes('[') || pattern.includes(']')) {
    const reason =
      pattern.includes('[') && !pattern.includes(']')
        ? 'unclosed character class'
        : 'unsupported character classes';

    return `Error: invalid exclude pattern '${pattern}': ${reason}`;
  }

  const source = pattern
    .replace(/[\\^$+?.()|{}]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');

  return new RegExp(`^${source}$`);
};

const resolve = (
  workspaceRoot: string,
  value: string,
): { readonly path: string; readonly relative: string } | string => {
  const root = normalize(workspaceRoot);

  const resolved = normalize(
    path.isAbsolute(value) ? value : path.join(root, value),
  );

  if (!contains(root, resolved)) {
    return `Path escapes workspace: ${value}`;
  }

  return {
    path: resolved,
    relative: resolved === root ? '' : resolved.slice(root.length + 1),
  };
};

const relative = (workspaceRoot: string, fullPath: string): string => {
  const root = normalize(workspaceRoot);

  return fullPath === root ? '' : fullPath.slice(root.length + 1);
};

const pathKind = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  value: string,
): Promise<WorkspacePathKind> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'sh',
      '-c',
      'if [ -d "$1" ]; then printf directory; elif [ -f "$1" ]; then printf file; elif [ -e "$1" ]; then printf other; else printf missing; fi',
      'sh',
      value,
    ],
  });

  if (result.exitCode !== 0) {
    return 'missing';
  }

  return parsePathKind(result.stdout);
};

const parsePathKind = (value: string): WorkspacePathKind => {
  const normalized = value.trim();

  if (
    normalized === 'directory' ||
    normalized === 'file' ||
    normalized === 'missing' ||
    normalized === 'other'
  ) {
    return normalized;
  }

  return 'missing';
};

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);

const lines = (value: string): readonly string[] =>
  value.split(/\r?\n/).filter((line) => line !== '');

const normalize = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};
