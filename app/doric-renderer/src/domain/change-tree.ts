import { baseName, joinPath, parentPath } from './files';
import type {
  ProjectChange,
  ProjectChangeStatus,
  ProjectTreeNode,
} from './workspace';

export type ChangeRepository = {
  readonly path: string;
  readonly changes: readonly ProjectChange[];
};

export type ChangeDecoration = {
  readonly status?: ProjectChangeStatus;
  readonly count: number;
  readonly description: string;
};

export const changeClassName = (status: ProjectChangeStatus): string => {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-git-added';
    case 'modified':
      return 'text-git-modified';
    case 'deleted':
      return 'text-git-deleted';
    case 'renamed':
      return 'text-git-renamed';
    case 'conflicted':
      return 'text-git-conflicted';
  }
};

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

/** Changes retain their directory chain; search includes rename origins. */
export const changesTree = (
  repository: ChangeRepository,
  filter = '',
): readonly ProjectTreeNode[] => {
  const query = filter.trim().toLocaleLowerCase();
  const changes = repository.changes.filter((change) =>
    [joinPath(repository.path, change.path), change.originalPath].some((path) =>
      path?.toLocaleLowerCase().includes(query),
    ),
  );
  const branches = new Map<string, ProjectTreeNode[]>();
  branches.set(repository.path, []);
  const ensureDirectory = (path: string): ProjectTreeNode[] => {
    const existing = branches.get(path);
    if (existing !== undefined) return existing;
    const children: ProjectTreeNode[] = [];
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
  entries: readonly ProjectTreeNode[],
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
    decorations: changeDecorations([repository]),
    changes: new Map(
      repository.changes.map((change) => [
        joinPath(repository.path, change.path),
        change,
      ]),
    ),
  };
};
