import { isArchived } from './thread-archive.js';
import type { Project, Thread } from './workspace.js';

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

/** Whether the host has described a Project's Threads. */
export const isDescribed = (tree: ProjectTree, projectId: string): boolean =>
  tree.threadsByProject[projectId] !== undefined;

/** The Threads described for a Project, in the order the host listed them. */
export const threadsOf = (
  tree: ProjectTree,
  projectId: string | undefined,
): readonly Thread[] =>
  projectId === undefined ? [] : (tree.threadsByProject[projectId] ?? []);

/**
 * The tree with `selection` selected. When `selection` names no Thread, the
 * first main thread (no `parentThreadId`) of the selected Project that is not
 * archived is selected (docs/designs/thread-archive.md §10.1); with none, no
 * Thread is selected. A Thread `selection` names is kept as given, archived or
 * not. Selecting what is already selected answers `tree` itself (the same
 * object); otherwise a new tree. Pure; never throws.
 */
export const withSelection = (
  tree: ProjectTree,
  selection: Selection,
): ProjectTree => {
  const first = threadsOf(tree, selection.projectId).find(
    (thread) => thread.parentThreadId === undefined && !isArchived(thread),
  );
  const next =
    selection.threadId === undefined && first !== undefined
      ? { ...selection, threadId: first.id }
      : selection;
  // Selecting what is already selected keeps the tree, so it changes nothing
  // for the views and watchers that compare it.
  return next.projectId === tree.selection.projectId &&
    next.threadId === tree.selection.threadId
    ? tree
    : { ...tree, selection: next };
};

/**
 * The Projects whose Threads are on screen. Rows open and close one at a time:
 * opening or closing one leaves every other row exactly as it was, so the
 * sidebar never closes an item because another one opened.
 */
export type OpenProjects = ReadonlySet<string>;

export const isProjectOpen = (open: OpenProjects, projectId: string): boolean =>
  open.has(projectId);

export const withProjectOpen = (
  open: OpenProjects,
  projectId: string,
): OpenProjects => (open.has(projectId) ? open : new Set(open).add(projectId));

export const withProjectToggled = (
  open: OpenProjects,
  projectId: string,
): OpenProjects => {
  const next = new Set(open);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  return next;
};

/** Whether two lists hold the same values, in the same order. */
const sameList = <Value>(
  left: readonly Value[] | undefined,
  right: readonly Value[],
): boolean =>
  left !== undefined &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const holds = (
  values: readonly { readonly id: string }[] | undefined,
  id: string,
): boolean => values?.some((value) => value.id === id) ?? false;

/**
 * The tree with the records of `runtime.records/v1`: its Projects and the
 * Threads of the Projects it described. A list equal to the one the tree
 * holds keeps the tree's own array, and a tree that changes nothing is
 * answered itself (the same object).
 *
 * The selection is repaired as the record rules did (R6):
 * - the selected Project leaving the Projects empties the selection;
 * - the selected Thread leaving its Project's described Threads keeps the
 *   Project alone;
 * - when the selected Project's Threads change, a selection with no Thread
 *   takes the first main Thread that is not archived (`withSelection`).
 * Pure; never throws.
 */
export const withRecords = (
  tree: ProjectTree,
  records: Pick<ProjectTree, 'projects' | 'threadsByProject'>,
): ProjectTree => {
  const projects = sameList(tree.projects, records.projects)
    ? tree.projects
    : records.projects;
  const entries = Object.entries(records.threadsByProject).map(
    ([projectId, threads]): [string, readonly Thread[]] => {
      const known = tree.threadsByProject[projectId];
      return [
        projectId,
        known !== undefined && sameList(known, threads) ? known : threads,
      ];
    },
  );
  const threadsByProject =
    entries.length === Object.keys(tree.threadsByProject).length &&
    entries.every(
      ([projectId, threads]) => tree.threadsByProject[projectId] === threads,
    )
      ? tree.threadsByProject
      : Object.fromEntries(entries);

  const { projectId, threadId } = tree.selection;
  let selection = tree.selection;
  if (projectId !== undefined) {
    const described = threadsByProject[projectId];
    if (holds(tree.projects, projectId) && !holds(projects, projectId)) {
      selection = {};
    } else if (
      threadId !== undefined &&
      described !== undefined &&
      holds(tree.threadsByProject[projectId], threadId) &&
      !holds(described, threadId)
    ) {
      selection = { projectId };
    }
  }
  const next: ProjectTree = { projects, threadsByProject, selection };
  const changed =
    selection.projectId !== undefined &&
    threadsByProject[selection.projectId] !==
      tree.threadsByProject[selection.projectId];
  const repaired = changed ? withSelection(next, selection) : next;
  return repaired.projects === tree.projects &&
    repaired.threadsByProject === tree.threadsByProject &&
    repaired.selection.projectId === tree.selection.projectId &&
    repaired.selection.threadId === tree.selection.threadId
    ? tree
    : repaired;
};
