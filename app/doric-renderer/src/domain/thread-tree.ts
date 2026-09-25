import type { Draft, Thread } from '@/domain/workspace';

/**
 * The sidebar renders a flat thread list as a nested tree. This module is the
 * rule set for that shape: which threads are the direct children of a node,
 * which nodes can be expanded, and where an open thread draft lands. The
 * component only walks the structure it returns.
 */

/** One level of the tree: the nodes under a single parent and its pending draft. */
export type ThreadLevel = {
  readonly draft: boolean;
  readonly nodes: readonly ThreadNode[];
};

/** A thread in the tree, paired with the level of its own direct children. */
export type ThreadNode = {
  readonly thread: Thread;
  readonly children: ThreadLevel;
  /** Whether a person can toggle it open: it has children or a pending draft. */
  readonly expandable: boolean;
};

/**
 * Direct children of `parentThreadId` in a project, in list order. An undefined
 * `parentThreadId` selects the project's root threads.
 */
export const childThreads = (
  threads: readonly Thread[],
  projectId: string,
  parentThreadId?: string,
): readonly Thread[] =>
  threads.filter(
    (thread) =>
      thread.projectId === projectId &&
      thread.parentThreadId === parentThreadId,
  );

/** Whether a thread draft is currently open as a child of `parentThreadId`. */
export const isDraftChild = (
  draft: Draft | undefined,
  projectId: string,
  parentThreadId?: string,
): boolean =>
  draft !== undefined &&
  draft.kind === 'thread' &&
  draft.projectId === projectId &&
  draft.parentThreadId === parentThreadId;

/** Whether a level has anything under it worth toggling open. */
export const canExpand = (level: ThreadLevel): boolean =>
  level.nodes.length > 0 || level.draft;

/**
 * Builds the nested tree for one project, starting at `parentThreadId` (the
 * project root when omitted). Threads from other projects are ignored.
 */
export const threadLevel = (
  threads: readonly Thread[],
  draft: Draft | undefined,
  projectId: string,
  parentThreadId?: string,
): ThreadLevel => ({
  draft: isDraftChild(draft, projectId, parentThreadId),
  nodes: childThreads(threads, projectId, parentThreadId).map((thread) => {
    const children = threadLevel(threads, draft, projectId, thread.id);
    return { thread, children, expandable: canExpand(children) };
  }),
});

/** Whether an expandable node is currently open given the collapsed set. */
export const isExpanded = (
  node: ThreadNode,
  collapsed: ReadonlySet<string>,
): boolean => node.expandable && !collapsed.has(node.thread.id);

/**
 * The chain of Threads from the outermost ancestor down to `threadId`, so a
 * breadcrumb can name the path a Thread sits on. A Thread whose ancestors are
 * not in `threads` stops there, and a cycle or an unknown id yields only what
 * was actually walked rather than an unbounded loop.
 */
export const threadPath = (
  threads: readonly Thread[],
  threadId: string,
): readonly Thread[] => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const path: Thread[] = [];
  const seen = new Set<string>();
  let current = byId.get(threadId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current =
      current.parentThreadId === undefined
        ? undefined
        : byId.get(current.parentThreadId);
  }
  return path;
};
