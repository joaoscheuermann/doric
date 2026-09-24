import type {
  ProjectChangeStatus,
  ProjectDiff,
  ProjectLeaseState,
} from './workspace';

/** The workspace root: every path this surface carries is relative to it. */
export const ROOT_PATH = '';

/** What a breadcrumb or a title calls the workspace root. */
export const ROOT_NAME = 'workspace';

/** The path of `name` inside `dir`. */
export const joinPath = (dir: string, name: string): string =>
  dir === ROOT_PATH ? name : `${dir}/${name}`;

/** The directory that holds `path`; the root holds a name with no separator. */
export const parentPath = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? ROOT_PATH : path.slice(0, separator);
};

/** The last segment of `path`: the file or directory it names, not its chain. */
export const baseName = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? path : path.slice(separator + 1);
};

/**
 * Whether `path` names `dir` itself or something below it. The root contains
 * every path, its own included.
 */
export const isWithin = (path: string, dir: string): boolean =>
  dir === ROOT_PATH || path === dir || path.startsWith(`${dir}/`);

export type PathSegment = {
  readonly name: string;
  readonly path: string;
};

/**
 * The breadcrumb chain from the workspace root down to `path`. The first
 * segment is the root, named for it; every later segment carries the path it
 * selects.
 */
export const pathSegments = (path: string): readonly PathSegment[] => {
  const segments: PathSegment[] = [{ name: ROOT_NAME, path: ROOT_PATH }];
  let current = ROOT_PATH;
  for (const name of path.split('/')) {
    if (name.length === 0) continue;
    current = joinPath(current, name);
    segments.push({ name, path: current });
  }
  return segments;
};

/** How many trailing crumbs a collapsed chain keeps: the file and its directory. */
const TRAILING_CRUMBS = 2;

/** The shortest chain that collapses: the root, a crumb to hide, and the trailing two. */
const MINIMUM_CRUMBS = TRAILING_CRUMBS + 2;

export type CollapsedPath = {
  /** The root, always shown, so the chain keeps the workspace it starts from. */
  readonly leading: PathSegment;
  /** The crumbs in between, reached through the collapsed trigger. */
  readonly hidden: readonly PathSegment[];
  /** The trailing crumbs, ending at the open file. */
  readonly trailing: readonly PathSegment[];
};

/**
 * Splits a chain for a row that cannot hold it: the root, the crumbs in between,
 * and the last two, which are the directory the file sits in and the file
 * itself. A chain of three crumbs or fewer — the root, one directory and the
 * file — is short enough to read in full, so nothing is hidden; a deeper one puts
 * its middle behind the collapsed trigger rather than clipping it.
 */
export const collapsedPath = (path: string): CollapsedPath => {
  const segments = pathSegments(path);
  const [leading = { name: ROOT_NAME, path: ROOT_PATH }, ...rest] = segments;

  if (segments.length < MINIMUM_CRUMBS) {
    return { leading, hidden: [], trailing: rest };
  }

  return {
    leading,
    hidden: rest.slice(0, rest.length - TRAILING_CRUMBS),
    trailing: rest.slice(rest.length - TRAILING_CRUMBS),
  };
};

/** The expanded set with `path` added when absent and removed when present. */
export const toggleExpanded = (
  expanded: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> => {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
};

export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta';

export type DiffLine = {
  readonly kind: DiffLineKind;
  /** The line without its `+`/`-`/space marker, which `kind` already carries. */
  readonly text: string;
};

export type DiffFile = {
  /** The `b/` post-image, because that is the path the file view can open. */
  readonly path: string;
  readonly lines: readonly DiffLine[];
};

const HEADER_PREFIX = 'diff --git ';

const NO_NEWLINE = '\\ No newline at end of file';

/** The post-image path a `diff --git` header names, or nothing when it is one. */
const headerPath = (line: string): string | undefined => {
  if (!line.startsWith(HEADER_PREFIX)) return undefined;
  const rest = line.slice(HEADER_PREFIX.length);
  // A path the host quoted, as git does for anything it cannot print plainly.
  const quoted = /^"(.*)" "(.*)"$/.exec(rest);
  if (quoted !== null) {
    const post = quoted[2] ?? '';
    return post.startsWith('b/') ? post.slice(2) : post;
  }
  const plain = /^a\/(.*) b\/(.*)$/.exec(rest);
  return plain?.[2];
};

const lineKind = (line: string, inHunk: boolean): DiffLineKind => {
  if (line.startsWith('@@') || line === NO_NEWLINE || !inHunk) return 'meta';
  const marker = line.charAt(0);
  if (marker === '+') return 'add';
  if (marker === '-') return 'remove';
  if (marker === ' ' || line === '') return 'context';
  return 'meta';
};

/**
 * Splits a unified diff into the files it patches. The `diff --git` line that
 * starts a file is what splits them, so it is not a line of any file, and the
 * path a file is known by is its `b/` post-image, which is what the file view
 * can open. A hunk header, a `\ No newline` marker and anything else that is
 * not a line of a hunk stay `meta` lines; text before the first header belongs
 * to no file and is dropped.
 */
export const classifyDiff = (diff: ProjectDiff): readonly DiffFile[] => {
  const text = diff.diff.endsWith('\n') ? diff.diff.slice(0, -1) : diff.diff;
  const files: DiffFile[] = [];
  let path: string | undefined;
  let lines: DiffLine[] = [];
  let inHunk = false;

  const close = (): void => {
    if (path !== undefined) files.push({ path, lines });
  };

  for (const line of text.split('\n')) {
    const header = headerPath(line);
    if (header !== undefined || line.startsWith(HEADER_PREFIX)) {
      close();
      path = header;
      lines = [];
      inHunk = false;
      continue;
    }
    if (path === undefined) continue;
    if (line.startsWith('@@')) inHunk = true;
    const kind = lineKind(line, inHunk);
    lines.push({ kind, text: kind === 'meta' ? line : line.slice(1) });
  }
  close();

  return files;
};

export type DiffStat = { readonly added: number; readonly removed: number };

/** The added and removed line counts across every file a diff patches. */
export const diffStat = (files: readonly DiffFile[]): DiffStat => {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const line of file.lines) {
      if (line.kind === 'add') added += 1;
      else if (line.kind === 'remove') removed += 1;
    }
  }
  return { added, removed };
};

/**
 * What the editor calls text it has no grammar for; `plaintext` is Monaco's own
 * id for it, so an unknown file still reads as its own text.
 */
const PLAINTEXT = 'plaintext';

/** The language id each extension this surface knows how to highlight gets. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'shell',
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  htm: 'html',
  html: 'html',
  js: 'javascript',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

/**
 * The language the file view reads `path` as, by its extension alone: a name
 * with no extension, or one this surface has no grammar for, is `plaintext`.
 * JSON is deliberately one of those: Monaco serves it as a language service
 * with a worker of its own, and this surface bundles the editor worker only.
 */
export const fileLanguage = (path: string): string => {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return PLAINTEXT;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? PLAINTEXT;
};

/** The sentence shown under a payload the host cut short, if it did. */
export const truncationNotice = (truncated: boolean): string | undefined =>
  truncated
    ? 'This file is larger than the read limit, so only its first part is shown.'
    : undefined;

/** The sentence an empty directory shows instead of nothing at all. */
export const emptyDirectoryNotice = 'This directory is empty.';

export type SandboxStatus = ProjectLeaseState | 'invalid_path' | 'not_found';

/**
 * The sentence a Project's sandbox shows when the surface cannot read it. A
 * queued lease carries the host's own retry hint, so the surface repeats it
 * rather than inventing a wait of its own.
 */
export const sandboxNotice = (
  status: SandboxStatus,
  retryAfterSeconds?: number,
): string => {
  switch (status) {
    case 'pending':
      return retryAfterSeconds === undefined
        ? 'The sandbox is still being prepared.'
        : `The sandbox is still being prepared; the host suggests trying again in ${retryAfterSeconds} seconds.`;
    case 'expired':
      return 'The sandbox lease for this Project expired, so its files are no longer readable.';
    case 'unavailable':
      return 'The sandbox is unavailable, so this Project has no files to show.';
    case 'missing':
      return 'This Project has no sandbox yet, so it has no files to show.';
    case 'invalid_path':
      return 'That path is not inside the workspace.';
    case 'not_found':
      return 'That path is no longer in the workspace.';
  }
};

const changeLetters: Record<ProjectChangeStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: 'U',
};

/** The letter a changed file's badge carries. */
export const changeLetter = (status: ProjectChangeStatus): string =>
  changeLetters[status];
