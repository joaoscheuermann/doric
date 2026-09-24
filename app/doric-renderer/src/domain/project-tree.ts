import type { Project, ProjectUpdate, Thread } from './workspace';
import { threadsForProject, threadSubtreeIds, upsert } from './workspace';

/**
 * The Project the user selected and the Thread selected inside it. A selected
 * Thread is always owned by the selected Project, so the two travel together:
 * losing the Project loses its Thread even when nothing ever described it.
 */
export type Selection = {
  readonly projectId?: string;
  readonly threadId?: string;
};

/**
 * The renderer's copy of the host's Project tree: the Projects it knows, the
 * Threads the host described for each of them, and what the user selected.
 *
 * `threadsByProject` is also the readiness record. A Project appears in it only
 * once the host has described its Threads, through a list load or a live
 * snapshot, so an absent key means "not described yet" and never "no Threads".
 */
export type ProjectTree = {
  readonly projects: readonly Project[];
  readonly threadsByProject: Readonly<Record<string, readonly Thread[]>>;
  readonly selection: Selection;
};

export const emptyTree: ProjectTree = {
  projects: [],
  threadsByProject: {},
  selection: {},
};

/** The Project updates that describe the tree; a failure is reported, not reduced. */
export type TreeUpdate = Exclude<ProjectUpdate, { readonly kind: 'error' }>;

/** Whether the host has described a Project's Threads. */
export const isDescribed = (tree: ProjectTree, projectId: string): boolean =>
  tree.threadsByProject[projectId] !== undefined;

/** The Threads described for a Project, in the order the host listed them. */
export const threadsOf = (
  tree: ProjectTree,
  projectId: string | undefined,
): readonly Thread[] =>
  projectId === undefined ? [] : (tree.threadsByProject[projectId] ?? []);

export const withSelection = (
  tree: ProjectTree,
  selection: Selection,
): ProjectTree => ({ ...tree, selection });

/**
 * The Projects the host listed, keeping the ones already known ahead of the new
 * ones, so a live addition never reorders the sidebar under the user.
 */
export const withProjects = (
  tree: ProjectTree,
  projects: readonly Project[],
): ProjectTree => {
  const known = new Set(tree.projects.map((project) => project.id));
  return {
    ...tree,
    projects: [
      ...tree.projects,
      ...projects.filter((project) => !known.has(project.id)),
    ],
  };
};

export const withProject = (
  tree: ProjectTree,
  project: Project,
): ProjectTree => ({ ...tree, projects: upsert(tree.projects, project) });

/**
 * A Project's Threads as the host described them. This is what makes a Project
 * ready, so it is the only way a Project's Threads become trusted.
 */
export const withThreads = (
  tree: ProjectTree,
  projectId: string,
  threads: readonly Thread[],
): ProjectTree => ({
  ...tree,
  threadsByProject: {
    ...tree.threadsByProject,
    [projectId]: threadsForProject(threads, projectId),
  },
});

/**
 * One Thread, added or replaced. A new Thread lands where the caller asks,
 * because the host lists Threads in creation order.
 */
export const withThread = (
  tree: ProjectTree,
  thread: Thread,
  position: 'first' | 'last' = 'first',
): ProjectTree => ({
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

/**
 * Replaces the Threads of a Project the host already described. A Project whose
 * Threads were never described stays undescribed rather than being filled in
 * with what a removal guessed.
 */
const replaceThreads = (
  tree: ProjectTree,
  projectId: string,
  threads: readonly Thread[],
): ProjectTree =>
  tree.threadsByProject[projectId] === undefined
    ? tree
    : {
        ...tree,
        threadsByProject: { ...tree.threadsByProject, [projectId]: threads },
      };

/**
 * A Project and everything that belonged to it. Ownership decides: the Project
 * goes, its described Threads go, and a selection pointing at it goes too,
 * even when no loaded list ever named the selected Thread. Nothing here reads
 * a Thread list to decide what the Project owned, so a stale or absent cache
 * cannot leave a selection behind.
 */
export const forgetProject = (
  tree: ProjectTree,
  projectId: string,
): ProjectTree => ({
  projects: tree.projects.filter((project) => project.id !== projectId),
  threadsByProject: Object.fromEntries(
    Object.entries(tree.threadsByProject).filter(([id]) => id !== projectId),
  ),
  selection: tree.selection.projectId === projectId ? {} : tree.selection,
});

/**
 * A Thread and its subtree. The subtree comes from the Threads that were
 * described, and the selection loses the Thread while keeping its Project.
 */
export const forgetThread = (
  tree: ProjectTree,
  projectId: string,
  threadId: string,
): ProjectTree => {
  const described = threadsOf(tree, projectId);
  const threadIds = threadSubtreeIds(described, threadId);
  return {
    ...replaceThreads(
      tree,
      projectId,
      described.filter((thread) => !threadIds.has(thread.id)),
    ),
    selection:
      tree.selection.threadId !== undefined &&
      threadIds.has(tree.selection.threadId)
        ? { projectId: tree.selection.projectId }
        : tree.selection,
  };
};

/** The transition a live Project update makes. */
export const applyUpdate = (
  tree: ProjectTree,
  update: TreeUpdate,
): ProjectTree => {
  switch (update.kind) {
    case 'snapshot':
      return withThreads(
        tree,
        update.snapshot.projectId,
        update.snapshot.threads,
      );
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
