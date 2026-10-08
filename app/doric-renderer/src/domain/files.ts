import type {
  ProjectChangeStatus,
  ProjectFileContent,
  ProjectFileResult,
  ProjectLeaseState,
  ProjectTreeNode,
  ProjectTreeResult,
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
  conflicted: '!',
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: 'U',
};

/** The letter a changed file's badge carries. */
export const changeLetter = (status: ProjectChangeStatus): string =>
  changeLetters[status];

/**
 * What a read of the sandbox answered. `idle` is "not asked yet", and the lease
 * states and the two refusals are data rather than failures, because the
 * surface explains them instead of erroring.
 */
export type ReadState<Value> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: SandboxStatus; readonly retryAfterSeconds?: number };

/**
 * What the tree shows. A reread that fails keeps a tree already on screen and
 * falls back to the loading shape otherwise, while the surface explains the
 * failure beside it.
 */
export const treeReadState = (
  result: ProjectTreeResult | undefined,
  failed: boolean,
): ReadState<readonly ProjectTreeNode[]> => {
  if (result?.status === 'ready') {
    return { status: 'ready', value: result.entries };
  }
  if (result !== undefined && !failed) return result;
  return { status: 'loading' };
};

/**
 * What the open file shows. Background reads and failures keep the last text
 * available; only the first read needs a loading placeholder.
 */
export const fileReadState = (
  result: ProjectFileResult | undefined,
  loading: boolean,
  failed: boolean,
): ReadState<ProjectFileContent> => {
  if (result?.status === 'ready')
    return { status: 'ready', value: result.file };
  if (loading) return { status: 'loading' };
  if (failed || result === undefined) return { status: 'idle' };
  return result;
};
