// The record rules of the window's mirror (bundle isolation phase 3): the
// Projects and the Threads the host described, without the layout's
// selection. Every rule is pure and returns a new tree.

import type { ErrorInfo } from 'desktop/reads';

import {
  type Project,
  type Thread,
  threadSubtreeIds,
} from '../../contracts/index.js';

/** The records the mirror holds. */
export interface RecordsTree {
  readonly projects: readonly Project[];
  /** The Threads of each described Project; an absent key is "not yet". */
  readonly threadsByProject: Readonly<Record<string, readonly Thread[]>>;
}

/** One live notice of a followed Project, or the end of its stream. */
export type ProjectUpdate =
  | {
      readonly kind: 'snapshot';
      readonly snapshot: {
        readonly projectId: string;
        readonly project: Project | null;
        readonly threads: readonly Thread[];
      };
    }
  | { readonly kind: 'thread-updated'; readonly thread: Thread }
  | {
      readonly kind: 'thread-deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'project-updated'; readonly project: Project }
  | { readonly kind: 'project-deleted'; readonly projectId: string }
  | { readonly kind: 'error'; readonly error: ErrorInfo };

/** A notice that changes the records. */
export type TreeUpdate = Exclude<ProjectUpdate, { readonly kind: 'error' }>;

export const threadsForProject = (
  threads: readonly Thread[],
  projectId: string,
): readonly Thread[] =>
  threads.filter((thread) => thread.projectId === projectId);

/**
 * Replaces the value with the same id in its place, or adds it: first by
 * default, after the others with `'last'`.
 */
export const upsert = <Value extends { readonly id: string }>(
  values: readonly Value[],
  value: Value,
  position: 'first' | 'last' = 'first',
): readonly Value[] => {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) {
    return position === 'last' ? [...values, value] : [value, ...values];
  }
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
};

/** `threads` without `rootId` and every Thread below it. */
export const withoutThreadSubtree = (
  threads: readonly Thread[],
  rootId: string,
): readonly Thread[] => {
  const ids = threadSubtreeIds(threads, rootId);
  return threads.filter((thread) => !ids.has(thread.id));
};

/** Adds the listed Projects it does not know after the ones it knows. */
export const withProjects = (
  tree: RecordsTree,
  projects: readonly Project[],
): RecordsTree => {
  const known = new Set(tree.projects.map((project) => project.id));
  return {
    ...tree,
    projects: [
      ...tree.projects,
      ...projects.filter((project) => !known.has(project.id)),
    ],
  };
};

/** Replaces the Project in its place, or adds it first. */
export const withProject = (
  tree: RecordsTree,
  project: Project,
): RecordsTree => ({ ...tree, projects: upsert(tree.projects, project) });

/** Describes the Project with the Threads of `threads` that are its own. */
export const withThreads = (
  tree: RecordsTree,
  projectId: string,
  threads: readonly Thread[],
): RecordsTree => ({
  ...tree,
  threadsByProject: {
    ...tree.threadsByProject,
    [projectId]: threadsForProject(threads, projectId),
  },
});

/** Replaces the Thread in its place, or adds it at `position`. */
export const withThread = (
  tree: RecordsTree,
  thread: Thread,
  position: 'first' | 'last' = 'first',
): RecordsTree => ({
  ...tree,
  threadsByProject: {
    ...tree.threadsByProject,
    [thread.projectId]: upsert(
      threadsForProject(
        tree.threadsByProject[thread.projectId] ?? [],
        thread.projectId,
      ),
      thread,
      position,
    ),
  },
});

/** The Project and the Threads described for it leave the tree. */
export const forgetProject = (
  tree: RecordsTree,
  projectId: string,
): RecordsTree => ({
  projects: tree.projects.filter((project) => project.id !== projectId),
  threadsByProject: Object.fromEntries(
    Object.entries(tree.threadsByProject).filter(([id]) => id !== projectId),
  ),
});

/** The Thread and its subtree leave the Project's described Threads. */
export const forgetThread = (
  tree: RecordsTree,
  projectId: string,
  threadId: string,
): RecordsTree => {
  const described = tree.threadsByProject[projectId];
  if (described === undefined) return tree;
  return {
    ...tree,
    threadsByProject: {
      ...tree.threadsByProject,
      [projectId]: withoutThreadSubtree(described, threadId),
    },
  };
};

/**
 * Applies one notice. A snapshot is the truth about the Project's Threads,
 * and its Project replaces the listed one.
 */
export const applyUpdate = (
  tree: RecordsTree,
  update: TreeUpdate,
): RecordsTree => {
  switch (update.kind) {
    case 'snapshot': {
      const { projectId, project, threads } = update.snapshot;
      const listed =
        project !== null &&
        tree.projects.some((candidate) => candidate.id === project.id)
          ? withProject(tree, project)
          : tree;
      return withThreads(listed, projectId, threads);
    }
    case 'thread-updated':
      // An agent-created Thread lands after its siblings instead of jumping to
      // the top, matching the creation order the server lists them in.
      return withThread(tree, update.thread, 'last');
    case 'thread-deleted':
      return forgetThread(tree, update.projectId, update.threadId);
    case 'project-updated':
      return withProject(tree, update.project);
    case 'project-deleted':
      return forgetProject(tree, update.projectId);
  }
};
