import type { ConfigurationValue } from '../../contracts/configuration.js';
import type { Thread } from '../../contracts/model.js';

/*
 * The archive rules (docs/designs/thread-archive.md §2): pure, no I/O, times
 * in epoch milliseconds. The archiver and the service gather the facts and
 * write; these functions only decide. None of them throws on well-formed
 * facts, and none walks a tree: callers pass the descendants they built.
 */

/** How long after a turn's end, or a view's end, an agent thread waits. */
export const finishedDelayMs = 30_000;
export const dayMs = 86_400_000;

const afterDays = { '1d': 1, '7d': 7, '30d': 30 } as const;

/** The states that keep a Thread pending for the main-thread rule. */
const pendingStates = new Set(['queued', 'running', 'cancelling', 'failed']);

/** No restore, or a turn ended after the last one (D6). */
const endedAfterRestore = (facts: ArchiveFacts): boolean =>
  facts.restoredAt === undefined ||
  (facts.thread.result !== undefined &&
    Date.parse(facts.thread.result.at) > Date.parse(facts.restoredAt));

/** The configuration's `threads.autoArchive`, defaults applied. */
export interface AutoArchiveSettings {
  readonly agentThreads: boolean;
  /** Undefined: never. */
  readonly mainThreadsAfterMs?: number;
}

/**
 * `agentThreads` absent → true; `mainThreadsAfter` absent → '7d'; '1d' |
 * '7d' | '30d' → 1, 7, 30 × dayMs; 'never' → undefined. An absent `threads`
 * or `autoArchive` reads as all defaults.
 */
export const autoArchiveSettings = (
  configuration: ConfigurationValue,
): AutoArchiveSettings => {
  const choice = configuration.threads?.autoArchive;
  const after = choice?.mainThreadsAfter ?? '7d';
  return {
    agentThreads: choice?.agentThreads ?? true,
    ...(after === 'never'
      ? {}
      : { mainThreadsAfterMs: afterDays[after] * dayMs }),
  };
};

/** What a rule reads about one Thread. */
export interface ArchiveFacts {
  readonly thread: Thread;
  /** The batch of the archive it carries; absent while not archived. */
  readonly batch?: string;
  readonly restoredAt?: string;
  readonly viewedAt?: string;
  /** The stored result carries reason 'interrupted' (D23). */
  readonly interrupted: boolean;
  /** Busy: state queued, running or cancelling, or live jobs, an active prompt or a storage pause. */
  readonly busy: boolean;
  /** At least one view is held. */
  readonly viewing: boolean;
  /** hasQuestionForm(thread.result.text), from runtime/contracts (§2.1). */
  readonly question: boolean;
}

/** Whether a result blocks both rules (U3, U13): status 'failed', or 'cancelled' and interrupted. */
export const blockingResult = (facts: ArchiveFacts): boolean => {
  const status = facts.thread.result?.status;
  return status === 'failed' || (status === 'cancelled' && facts.interrupted);
};

/**
 * The time the agent-thread rule archives `facts.thread`, or undefined when
 * it does not under these facts. Defined only when every one holds:
 * 1. settings.agentThreads;
 * 2. origin 'agent' with a parent;
 * 3. not archived, not pinned;
 * 4. state 'ready' or 'cancelled';
 * 5. queuePaused not true, no question, not busy, not viewing;
 * 6. a result whose status is 'completed', or 'cancelled' and not interrupted;
 * 7. no restoredAt, or result.at > restoredAt.
 * Value: max(result.at, viewedAt ?? result.at) + finishedDelayMs.
 * It answers for the Thread alone, never for its descendants (D4).
 */
export const finishedDue = (
  facts: ArchiveFacts,
  settings: AutoArchiveSettings,
): number | undefined => {
  const { thread } = facts;
  const result = thread.result;
  if (
    !settings.agentThreads ||
    thread.origin !== 'agent' ||
    thread.parentThreadId === undefined ||
    thread.archivedAt !== undefined ||
    thread.pinned === true ||
    (thread.state !== 'ready' && thread.state !== 'cancelled') ||
    thread.queuePaused === true ||
    facts.question ||
    facts.busy ||
    facts.viewing ||
    result === undefined ||
    !(
      result.status === 'completed' ||
      (result.status === 'cancelled' && !facts.interrupted)
    ) ||
    !endedAfterRestore(facts)
  )
    return undefined;
  const ended = Date.parse(result.at);
  const viewed =
    facts.viewedAt === undefined ? ended : Date.parse(facts.viewedAt);
  return Math.max(ended, viewed) + finishedDelayMs;
};

/**
 * Whether a non-archived Thread is pending for the main-thread rule: state
 * queued, running, cancelling or failed; queuePaused true; a question; busy;
 * viewing; pinned; a blocking result; an unread result (viewedAt defined
 * and result.at > viewedAt); or restored with no turn ended since (restoredAt
 * defined and no result, or result.at <= restoredAt, D6). An archived Thread
 * is never pending.
 */
export const pending = (facts: ArchiveFacts): boolean => {
  const { thread } = facts;
  if (thread.archivedAt !== undefined) return false;
  const result = thread.result;
  return (
    pendingStates.has(thread.state) ||
    thread.queuePaused === true ||
    facts.question ||
    facts.busy ||
    facts.viewing ||
    thread.pinned === true ||
    blockingResult(facts) ||
    (facts.viewedAt !== undefined &&
      result !== undefined &&
      Date.parse(result.at) > Date.parse(facts.viewedAt)) ||
    !endedAfterRestore(facts)
  );
};

/**
 * The time the main-thread rule archives `root` and its non-archived
 * descendants, or undefined. `descendants` is every descendant of `root`.
 * Defined only when settings.mainThreadsAfterMs is defined, root has no
 * parent and is not archived, and no Thread of [root, ...descendants] is
 * pending — so a subtree holding a Thread restored without a turn ended
 * since its restore is never due (D6, D7). Value: the latest of every
 * createdAt and result.at in [root, ...descendants] (archived Threads
 * included) and root's restoredAt, plus settings.mainThreadsAfterMs.
 */
export const inactiveDue = (
  root: ArchiveFacts,
  descendants: readonly ArchiveFacts[],
  settings: AutoArchiveSettings,
): number | undefined => {
  const after = settings.mainThreadsAfterMs;
  const all = [root, ...descendants];
  if (
    after === undefined ||
    root.thread.parentThreadId !== undefined ||
    root.thread.archivedAt !== undefined ||
    all.some(pending)
  )
    return undefined;
  const times = [
    ...all.flatMap(({ thread }) => [
      thread.createdAt,
      ...(thread.result === undefined ? [] : [thread.result.at]),
    ]),
    ...(root.restoredAt === undefined ? [] : [root.restoredAt]),
  ].map((time) => Date.parse(time));
  return Math.max(...times) + after;
};

/**
 * A manual archive of `target`: 'already_archived' when it is archived,
 * 'busy' when it is busy; else its id first, then, in the order of
 * `descendants`, the ids of every descendant that is not archived, not busy
 * and not pinned. Failed and cancelled descendants are included (D8).
 */
export const manualArchiveSet = (
  target: ArchiveFacts,
  descendants: readonly ArchiveFacts[],
): readonly string[] | 'busy' | 'already_archived' => {
  if (target.thread.archivedAt !== undefined) return 'already_archived';
  if (target.busy) return 'busy';
  return [
    target.thread.id,
    ...descendants
      .filter(
        ({ thread, busy }) =>
          thread.archivedAt === undefined && !busy && thread.pinned !== true,
      )
      .map(({ thread }) => thread.id),
  ];
};

/**
 * The ids a restore of `target` un-archives. The batch is `batch` when given,
 * else the target's own batch; with neither, the answer is empty. The answer
 * is the target, when it carries that batch, then every descendant carrying
 * it, in the order of `descendants`. Ancestors are never part of it.
 */
export const restoreSet = (
  target: ArchiveFacts,
  descendants: readonly ArchiveFacts[],
  batch?: string,
): readonly string[] => {
  const chosen = batch ?? target.batch;
  if (chosen === undefined) return [];
  return [target, ...descendants]
    .filter((facts) => facts.batch === chosen)
    .map(({ thread }) => thread.id);
};
