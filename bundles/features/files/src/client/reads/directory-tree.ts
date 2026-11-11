// The Files tree as it is read: per directory, on demand. The tree query holds
// one listing per directory it read — the root and the directories open in
// it — and the tree the panel draws is assembled from those listings, so a
// directory that was never read simply has no `children` yet.

import type {
  DirectoryListing,
  ProjectDirectoriesResult,
  ProjectTreeNode,
  ProjectTreeResult,
} from './project-files.js';

type Listings = Readonly<Record<string, DirectoryListing>>;

/** `path`'s parent in a tree rooted at `root`; the root's children have `root`. */
const parentOf = (root: string, path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut === -1 || cut < root.length ? root : path.slice(0, cut);
};

const under = (root: string, path: string): boolean =>
  path !== root && (root === '' || path.startsWith(`${root}/`));

/**
 * The open directories the tree shows, outermost first: every expanded
 * directory under `root` whose ancestors below `root` are all open. A
 * directory whose parent was read and holds no directory of that path (it was
 * removed, or became a file) is not shown, and neither is anything below it;
 * a directory whose parent was not read yet is (Reveal in Files opens a whole
 * chain at once).
 */
export const openDirectories = (
  root: string,
  expanded: ReadonlySet<string>,
  listings: Listings,
): readonly string[] => {
  const open = new Set<string>();
  const candidates = [...expanded]
    .filter((path) => under(root, path))
    .sort((left, right) => left.split('/').length - right.split('/').length);
  for (const path of candidates) {
    const parent = parentOf(root, path);
    if (parent !== root && !open.has(parent)) continue;
    const listing = listings[parent];
    if (
      listing?.status === 'listed' &&
      !listing.entries.some(
        (entry) => entry.path === path && entry.type === 'directory',
      )
    )
      continue;
    open.add(path);
  }
  return [...open];
};

/** The open directories no listing was read for yet. */
export const unreadDirectories = (
  root: string,
  expanded: ReadonlySet<string>,
  listings: Listings,
): readonly string[] =>
  openDirectories(root, expanded, listings).filter(
    (path) => listings[path] === undefined,
  );

const assembled = new WeakMap<object, ProjectTreeResult>();

/**
 * The tree the panel draws from the directories read so far: the root's
 * entries, each directory carrying `children` once it was read. A root that is
 * gone answers as the whole-tree read did (`not_found`, else `invalid_path`).
 * The same read assembles to the same tree, so an unchanged refresh changes no
 * row.
 */
export const assembleTree = (
  result: ProjectDirectoriesResult | undefined,
  root: string,
): ProjectTreeResult | undefined => {
  if (result === undefined || result.status !== 'ready') return result;
  const cached = assembled.get(result);
  if (cached !== undefined) return cached;
  const { directories } = result;
  const top = directories[root];
  const build = (
    entries: readonly ProjectTreeNode[],
  ): readonly ProjectTreeNode[] =>
    entries.map((entry) => {
      if (entry.type !== 'directory') return entry;
      const listing = directories[entry.path];
      return listing?.status === 'listed'
        ? { ...entry, children: build(listing.entries) }
        : entry;
    });
  const tree: ProjectTreeResult =
    top?.status === 'listed'
      ? { status: 'ready', path: root, entries: build(top.entries) }
      : top?.status === 'not_found'
        ? { status: 'not_found' }
        : { status: 'invalid_path' };
  assembled.set(result, tree);
  return tree;
};
