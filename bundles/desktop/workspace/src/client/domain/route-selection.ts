import type { RouteMatch } from 'bundle/contracts';

import type { ProjectTree, Selection } from './project-tree.js';
import type { Thread } from './workspace.js';

/**
 * The window path is the persisted selection: Home is `/`, a Project is
 * `/projects/<projectId>`, and a selected Thread is
 * `/projects/<projectId>/threads/<threadId>`. The rules here are pure; the
 * route-selection store and hook apply them.
 */
export const THREAD_ROUTE = '/projects/:projectId/threads/:threadId';

export const WORKSPACE_ROUTE = '/';
export const PROJECTS_ROUTE = '/projects';
export const PROJECT_ROUTE = '/projects/:projectId';

export const projectPath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}`;

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
    : selection.projectId !== undefined
      ? projectPath(selection.projectId)
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
 * - `none`: the route already shows the selection, or is not the workspace's.
 * - `select`: the route names a Thread the tree describes.
 * - `restore`: the route names a Thread the tree does not describe yet; it
 *   is looked up the way a restored selection is.
 * - `canonical`: the route's Project disagrees with the already selected
 *   Thread; replace it with the Thread's actual Project path.
 * - `project`: the route names a Project view.
 * - `home`: the route names Home or the full Project list.
 */
export type RouteIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly thread: Thread }
  | {
      readonly kind: 'restore';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'canonical' }
  | { readonly kind: 'home' };

export const routeIntent = (
  match: RouteMatch | undefined,
  tree: ProjectTree,
): RouteIntent => {
  const target = routeThread(match);
  const selection = tree.selection;
  if (target !== undefined) {
    if (target.threadId === selection.threadId) {
      return target.projectId === selection.projectId
        ? { kind: 'none' }
        : { kind: 'canonical' };
    }
    const thread = describedThread(tree, target.threadId);
    return thread === undefined
      ? {
          kind: 'restore',
          projectId: target.projectId,
          threadId: target.threadId,
        }
      : { kind: 'select', thread };
  }
  if (match?.pattern === PROJECT_ROUTE) {
    const projectId = match.params.projectId;
    return projectId === undefined ||
      (projectId === selection.projectId && selection.threadId === undefined)
      ? { kind: 'none' }
      : { kind: 'project', projectId };
  }
  if (
    (match?.pattern === WORKSPACE_ROUTE || match?.pattern === PROJECTS_ROUTE) &&
    selection.projectId !== undefined
  ) {
    return { kind: 'home' };
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
  (match?.pattern === PROJECT_ROUTE && selectedProjectId
    ? `project:${selectedProjectId}`
    : undefined);
