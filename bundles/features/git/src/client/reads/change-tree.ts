// The changed paths of a Project as the Changes view and the file trees draw
// them (moved from `desktop/reads`, stage BWP-11): the tree rows, the marks a
// tree shows beside a path, and the totals the footer and the tabs read.

import { baseName, joinPath, parentPath } from 'desktop/reads';
import type { TreeNode } from 'desktop/ui/panels';

import type {
  ChangeMark,
  ProjectChange,
  ProjectChangeStatus,
} from '../../contracts/index.js';

export type ChangeRepository = {
  readonly path: string;
  readonly changes: readonly ProjectChange[];
};

/** A path's decoration before the tree draws it: the status and what it counts. */
export type ChangeDecoration = {
  readonly status: ProjectChangeStatus;
  readonly count: number;
  readonly description: string;
};

/**
 * The tree classes a status is drawn with. Arbitrary `var()` values name the
 * same colour variables the palette states (`--git-*`), which this bundle's own
 * stylesheet declares.
 */
export const changeClassName = (status: ProjectChangeStatus): string => {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-[var(--git-added)]';
    case 'modified':
      return 'text-[var(--git-modified)]';
    case 'deleted':
      return 'text-[var(--git-deleted)]';
    case 'renamed':
      return 'text-[var(--git-renamed)]';
    case 'conflicted':
      return 'text-[var(--git-conflicted)]';
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

export const changeDescription = (change: ProjectChange): string => {
  const placement =
    change.staged && change.unstaged
      ? 'Staged and unstaged'
      : change.staged
        ? 'Staged'
        : 'Unstaged';
  const origin =
    change.originalPath === undefined ? '' : ` · From ${change.originalPath}`;
  return `${change.status} · ${placement}${origin}`;
};

/** Decorate workspace-relative paths, including ancestors outside each repository. */
export const changeDecorations = (
  repositories: readonly ChangeRepository[],
): ReadonlyMap<string, ChangeDecoration> => {
  const decorations = new Map<string, ChangeDecoration>();
  for (const repository of repositories) {
    for (const change of repository.changes) {
      const path = joinPath(repository.path, change.path);
      decorations.set(path, {
        status: change.status,
        count: 1,
        description: changeDescription(change),
      });
      let parent = parentPath(path);
      while (parent !== '') {
        const previous = decorations.get(parent);
        const count = (previous?.count ?? 0) + 1;
        // Untracked and staged additions share the same visual status.
        const incoming =
          change.status === 'untracked' ? 'added' : change.status;
        const status =
          previous?.status === 'conflicted' || incoming === 'conflicted'
            ? 'conflicted'
            : previous?.status === undefined || previous.status === incoming
              ? incoming
              : 'modified';
        decorations.set(parent, {
          status,
          count,
          description: `${count} changed ${count === 1 ? 'file' : 'files'}`,
        });
        parent = parentPath(parent);
      }
    }
  }
  return decorations;
};

/** The marks the trees draw: each decorated path's colour, letter and count. */
export const changeMarks = (
  repositories: readonly ChangeRepository[],
): ReadonlyMap<string, ChangeMark> =>
  new Map(
    [...changeDecorations(repositories)].map(([path, decoration]) => [
      path,
      {
        description: decoration.description,
        count: decoration.count,
        tone: changeClassName(decoration.status),
        letter: changeLetter(decoration.status),
        struck: decoration.status === 'deleted',
      },
    ]),
  );

/** Changes retain their directory chain; search includes rename origins. */
export const changesTree = (
  repository: ChangeRepository,
  filter = '',
): readonly TreeNode[] => {
  const query = filter.trim().toLocaleLowerCase();
  const changes = repository.changes.filter((change) =>
    [joinPath(repository.path, change.path), change.originalPath].some((path) =>
      path?.toLocaleLowerCase().includes(query),
    ),
  );
  const branches = new Map<string, TreeNode[]>();
  branches.set(repository.path, []);
  const ensureDirectory = (path: string): TreeNode[] => {
    const existing = branches.get(path);
    if (existing !== undefined) return existing;
    const children: TreeNode[] = [];
    branches.set(path, children);
    ensureDirectory(parentPath(path)).push({
      name: baseName(path),
      path,
      type: 'directory',
      children,
    });
    return children;
  };
  for (const change of changes) {
    const path = joinPath(repository.path, change.path);
    ensureDirectory(parentPath(path)).push({
      name: baseName(path),
      path,
      type: 'file',
    });
  }
  for (const entries of branches.values())
    entries.sort(
      (left, right) =>
        Number(right.type === 'directory') -
          Number(left.type === 'directory') ||
        left.name.localeCompare(right.name),
    );
  return branches.get(repository.path) ?? [];
};

export const treeDirectories = (
  entries: readonly TreeNode[],
): readonly string[] =>
  entries.flatMap((entry) =>
    entry.type === 'directory'
      ? [entry.path, ...treeDirectories(entry.children ?? [])]
      : [],
  );

/** Repository-qualified identity prevents overlapping roots sharing expansion state. */
export const changeDirectoryKey = (repository: string, path: string): string =>
  JSON.stringify([repository, path]);

export const changesCount = (
  repositories: readonly ChangeRepository[],
): number =>
  repositories.reduce(
    (count, repository) => count + repository.changes.length,
    0,
  );

export const changedRepositories = <T extends ChangeRepository>(
  repositories: readonly T[],
): readonly T[] =>
  repositories.filter((repository) => repository.changes.length > 0);

export const changedLineTotals = (
  repositories: readonly { readonly added: number; readonly removed: number }[],
) =>
  repositories.reduce(
    (total, repository) => ({
      added: total.added + repository.added,
      removed: total.removed + repository.removed,
    }),
    { added: 0, removed: 0 },
  );

export const changesDirectoryKeys = (
  repositories: readonly ChangeRepository[],
): readonly string[] =>
  repositories.flatMap((repository) =>
    [repository.path, ...treeDirectories(changesTree(repository))].map((path) =>
      changeDirectoryKey(repository.path, path),
    ),
  );

export const hasMatchingChanges = (
  repositories: readonly ChangeRepository[],
  filter: string,
): boolean =>
  repositories.some((repository) => changesTree(repository, filter).length > 0);

export const changesTreeView = (
  repository: ChangeRepository,
  filter: string,
  collapsed: ReadonlySet<string>,
) => {
  const entries = changesTree(repository, filter);
  const key = changeDirectoryKey(repository.path, repository.path);
  const searching = filter.trim() !== '';
  return {
    entries,
    key,
    open: searching || !collapsed.has(key),
    expanded: new Set(
      treeDirectories(entries).filter(
        (path) =>
          searching ||
          !collapsed.has(changeDirectoryKey(repository.path, path)),
      ),
    ),
    decorations: changeMarks([repository]),
    changes: new Map(
      repository.changes.map((change) => [
        joinPath(repository.path, change.path),
        change,
      ]),
    ),
  };
};
