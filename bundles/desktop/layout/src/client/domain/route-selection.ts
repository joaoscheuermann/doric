import type { RouteMatch } from 'bundle/contracts';

import type { ProjectTree, Selection } from './project-tree.js';
import type { Thread } from './workspace.js';

/**
 * The window path is the persisted selection (stage 9, §5.5): a selected
 * Thread is `/projects/<projectId>/threads/<threadId>` and everything else,
 * a Project-only selection included, is `/`. The rules here are pure; the
 * route-selection store and hook apply them.
 */
export const THREAD_ROUTE = '/projects/:projectId/threads/:threadId';

export const WORKSPACE_ROUTE = '/';

export const threadPath = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

export type RouteThread = {
  readonly projectId: string;
  readonly threadId: string;
};

/** The Thread a route names, when it is the Thread route. */
export const routeThread = (
  match: RouteMatch | undefined,
): RouteThread | undefined => {
  if (match?.pattern !== THREAD_ROUTE) return undefined;
  const { projectId, threadId } = match.params;
  return projectId === undefined || threadId === undefined
    ? undefined
    : { projectId, threadId };
};

/** The path a selection is persisted as. */
export const pathFor = (selection: Selection): string =>
  selection.projectId !== undefined && selection.threadId !== undefined
    ? threadPath(selection.projectId, selection.threadId)
    : WORKSPACE_ROUTE;

/** A described Thread anywhere in the tree. */
export const describedThread = (
  tree: ProjectTree,
  threadId: string,
): Thread | undefined => {
  for (const threads of Object.values(tree.threadsByProject)) {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread !== undefined) return thread;
  }
  return undefined;
};

/**
 * What a navigation the layout did not make asks of the selection (back,
 * forward, a link):
 *
 * - `none`: the route already shows the selection, or is not the
 *   workspace's.
 * - `select`: the route names a Thread the tree describes.
 * - `restore`: the route names a Thread the tree does not describe yet; it
 *   is looked up the way a restored selection is.
 * - `project`: the route is `/` while a Thread is selected; the selection
 *   keeps only its Project.
 */
export type RouteIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly thread: Thread }
  | { readonly kind: 'restore'; readonly threadId: string }
  | { readonly kind: 'project'; readonly projectId: string };

export const routeIntent = (
  match: RouteMatch | undefined,
  tree: ProjectTree,
): RouteIntent => {
  const target = routeThread(match);
  const selection = tree.selection;
  if (target !== undefined) {
    if (target.threadId === selection.threadId) return { kind: 'none' };
    const thread = describedThread(tree, target.threadId);
    return thread === undefined
      ? { kind: 'restore', threadId: target.threadId }
      : { kind: 'select', thread };
  }
  if (
    match?.pattern === WORKSPACE_ROUTE &&
    selection.threadId !== undefined &&
    selection.projectId !== undefined
  ) {
    return { kind: 'project', projectId: selection.projectId };
  }
  return { kind: 'none' };
};

/**
 * The owner of the active tabs (decision "Abas do layout"): the route's
 * Thread, else the selected Project as `project:<id>`, else none.
 */
export const tabOwnerOf = (
  match: RouteMatch | undefined,
  selectedProjectId: string | undefined,
): string | undefined =>
  routeThread(match)?.threadId ??
  (selectedProjectId ? `project:${selectedProjectId}` : undefined);
