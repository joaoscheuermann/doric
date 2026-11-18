import type { Draft, Thread } from './workspace.js';

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

/**
 * Whether the Thread's own prompt runs (`running` with an active prompt). A
 * record with only one of `state === 'running'` and `activePromptId` counts as
 * idle.
 */
export const isThreadRunning = (thread: Thread): boolean =>
  thread.state === 'running' && thread.activePromptId !== undefined;

/** An active row: it shimmers, and shows its elapsed time from `startedAt`. */
export type ThreadActivity = {
  /** The badge start (§1); absent, the row shows no time (D2). */
  readonly startedAt?: string;
};

/** The Thread's own badge start (§1), or undefined when it has none that parses. */
const badgeStart = (thread: Thread): string | undefined => {
  if (isThreadRunning(thread)) {
    const started = thread.executionStartedAt;
    return started !== undefined && Number.isFinite(Date.parse(started))
      ? started
      : undefined;
  }
  if (thread.lastExecutionMs === undefined || thread.result === undefined) {
    return undefined;
  }
  const finished = Date.parse(thread.result.at);
  if (!Number.isFinite(finished)) return undefined;
  const started = finished - thread.lastExecutionMs;
  return Number.isFinite(started) ? new Date(started).toISOString() : undefined;
};

/**
 * The active Threads of `level` and its descendants, by id. A Thread is active
 * while it runs, while `busy(id)` answers true for it, or while any child is
 * active. Inactive Threads have no entry.
 *
 * - Every Thread of the level is visited, whatever the sidebar has collapsed
 *   or the search hides, so a hidden descendant still makes its ancestors
 *   active. `busy` is called exactly once for each of them, including Threads
 *   that are active anyway, and the pass takes time linear in the Threads.
 * - An entry's `startedAt` is the Thread's own badge start, never a
 *   descendant's. For a running Thread it is `executionStartedAt`. For an idle
 *   Thread it is `result.at − lastExecutionMs` as an ISO string, when
 *   `lastExecutionMs` is present and `result.at` parses. Otherwise it is
 *   absent: an active Thread with no badge start. A start that does not parse
 *   is left out.
 * - Pure: it reads only `level` and `busy`. A throw from `busy` leaves the
 *   pass, so give it an answer that never throws, such as `threadRowsBusy`.
 */
export const threadActivity = (
  level: ThreadLevel,
  busy: (threadId: string) => boolean,
): ReadonlyMap<string, ThreadActivity> => {
  const activity = new Map<string, ThreadActivity>();
  const visit = (current: ThreadLevel): boolean => {
    let any = false;
    for (const node of current.nodes) {
      const childActive = visit(node.children);
      const ownBusy = busy(node.thread.id);
      if (childActive || ownBusy || isThreadRunning(node.thread)) {
        const startedAt = badgeStart(node.thread);
        activity.set(
          node.thread.id,
          startedAt === undefined ? {} : { startedAt },
        );
        any = true;
      }
    }
    return any;
  };
  visit(level);
  return activity;
};

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
