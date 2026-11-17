// The sidebar's two tabs over one Project's Threads
// (docs/designs/thread-archive.md §10.1): which Threads the Chat tab and the
// Archived tab draw, which of them are context rows, and the rules a row's
// archive actions read. Pure: every answer is stated in terms of the
// arguments, and no input is mutated.

import { threadPath } from './thread-tree.js';
import { type Thread, threadSubtreeIds } from './workspace.js';

/** The sidebar tab that is open: Chat (U1, the default) or Archived. */
export type SidebarTab = 'chat' | 'archived';

/**
 * Whether the Thread is archived: its record carries `archivedAt`. Nothing
 * else is read, so a pinned or running record with `archivedAt` is archived.
 * Never throws.
 */
export const isArchived = (thread: Thread): boolean =>
  thread.archivedAt !== undefined;

/**
 * The Threads of `threads`, in input order, that are in `members` or an
 * ancestor of one; the ones not in `members` are context.
 */
const withAncestors = (
  threads: readonly Thread[],
  members: ReadonlySet<string>,
): TabThreads => {
  const kept = new Set<string>();
  for (const id of members) {
    for (const ancestor of threadPath(threads, id)) kept.add(ancestor.id);
  }
  return {
    threads: threads.filter(({ id }) => kept.has(id)),
    context: new Set([...kept].filter((id) => !members.has(id))),
  };
};

/** A sidebar tab's Threads and, among them, the context rows. */
export type TabThreads = {
  /** The Threads the tab draws, in the order of the input list. */
  readonly threads: readonly Thread[];
  /**
   * The ids of the context rows: Threads drawn only to place another row in
   * the tree. Always a subset of the ids in `threads`.
   */
  readonly context: ReadonlySet<string>;
};

/**
 * The Chat tab: every non-archived Thread and every archived ancestor of one,
 * in input order; the archived ones are context.
 *
 * Ancestors are found along the parent chain (`threadPath` of
 * `domain/thread-tree.ts`): the chain stops at a parent missing from
 * `threads` or at a cycle, so an orphan is kept as a root and a cycle never
 * loops. Each Thread appears at most once. When `draftParentId` names an
 * archived Thread of the list, that Thread and its ancestors are kept too, as
 * context. Never throws.
 */
export const chatThreads = (
  threads: readonly Thread[],
  /** The parent a sidebar draft row names (`Draft.parentThreadId`); kept as context when archived. */
  draftParentId?: string,
): TabThreads => {
  const members = new Set(
    threads.filter((thread) => !isArchived(thread)).map(({ id }) => id),
  );
  const tab = withAncestors(threads, members);
  const draftParent = threads.find(({ id }) => id === draftParentId);
  if (draftParent === undefined || !isArchived(draftParent)) return tab;
  const path = new Set(threadPath(threads, draftParent.id).map(({ id }) => id));
  const shown = new Set(tab.threads.map(({ id }) => id));
  return {
    threads: threads.filter(({ id }) => shown.has(id) || path.has(id)),
    context: new Set([...tab.context, ...path]),
  };
};

/** The Archived tab's sections, newest first. */
export type ArchivedSectionId = 'today' | 'week' | 'older';

/** One non-empty section of the Archived tab, with its header's label. */
export type ArchivedSection = TabThreads & {
  readonly id: ArchivedSectionId;
  /** 'Today' for `today`, 'Last 7 days' for `week`, 'Older' for `older`. */
  readonly label: 'Today' | 'Last 7 days' | 'Older';
};

/**
 * The section of an archive time in local time: 'today' from today's local
 * midnight on (a time after `now` too), 'week' from the local midnight seven
 * days before that, 'older' before.
 *
 * `at` is an ISO timestamp (`Thread.archivedAt`); one that does not parse
 * answers 'older'. Never throws.
 */
export const archivedSectionOf = (at: string, now: Date): ArchivedSectionId => {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return 'older';
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (time >= midnight.getTime()) return 'today';
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 7,
  );
  return time >= weekStart.getTime() ? 'week' : 'older';
};

const SECTIONS: readonly (readonly [
  ArchivedSectionId,
  ArchivedSection['label'],
])[] = [
  ['today', 'Today'],
  ['week', 'Last 7 days'],
  ['older', 'Older'],
];

/**
 * The Archived tab: per non-empty section, in the order today, week, older,
 * the Threads archived in it and every ancestor of one, in input order; the
 * ancestors not archived in that section are context.
 *
 * An archived Thread belongs to exactly one section (`archivedSectionOf` of
 * its `archivedAt`); an ancestor may appear in several sections, as a member
 * in its own and as context in the others. Ancestors are found as in
 * `chatThreads`. No archived Thread: an empty list. Never throws.
 */
export const archivedSections = (
  threads: readonly Thread[],
  now: Date,
): readonly ArchivedSection[] =>
  SECTIONS.flatMap(([id, label]) => {
    const members = new Set(
      threads
        .filter(
          ({ archivedAt }) =>
            archivedAt !== undefined &&
            archivedSectionOf(archivedAt, now) === id,
        )
        .map((thread) => thread.id),
    );
    return members.size === 0
      ? []
      : [{ id, label, ...withAncestors(threads, members) }];
  });

/**
 * Whether the row offers Archive: not archived, state not queued, running or
 * cancelling. Every other state (ready, completed, failed, cancelled, …)
 * answers true for a Thread that is not archived. Never throws.
 */
export const archivable = (thread: Thread): boolean =>
  !isArchived(thread) &&
  thread.state !== 'queued' &&
  thread.state !== 'running' &&
  thread.state !== 'cancelling';

/**
 * U16: how many descendants of `id` are not archived, for the Archived tab's
 * delete dialog. `id` itself is never counted; descendants are found through
 * `parentThreadId` within `threads` (`threadSubtreeIds` of
 * `domain/workspace.ts`), so an unknown `id` answers 0. Never throws.
 */
export const descendantsInChat = (
  threads: readonly Thread[],
  id: string,
): number => {
  const ids = threadSubtreeIds(threads, id);
  return threads.filter(
    (thread) => thread.id !== id && ids.has(thread.id) && !isArchived(thread),
  ).length;
};
