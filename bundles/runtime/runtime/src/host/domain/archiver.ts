import { randomUUID } from 'node:crypto';

import {
  ContractError,
  type Disposable,
  isContractError,
  type Log,
} from 'bundle/contracts';

import { hasQuestionForm } from '../../contracts/fences.js';
import type { Thread } from '../../contracts/model.js';
import type { ArchiveState, ThreadStore } from '../store/types.js';
import {
  type ArchiveFacts,
  type AutoArchiveSettings,
  finishedDue,
  inactiveDue,
} from './archive.js';
import {
  type ProjectRuntime,
  subtreeIds,
  type ThreadRuntime,
} from './runtime.js';
import type { WorkspacePublisher } from './types.js';

/*
 * The archiver (docs/designs/thread-archive.md §5): the view counts of this
 * process and one sweep every `sweepIntervalMs` over the live Projects, for
 * both archive rules. It decides through the rules of `archive.ts` and writes
 * through `writeArchive`.
 */

/** The pause between the end of one sweep and the start of the next. */
const sweepIntervalMs = 10_000;
/** How long a Project must have been live here before a sweep reads it (D29). */
export const projectGraceMs = 30_000;

/** Runs `run` after `ms`; answers the cancel. The host's default unrefs its timer. */
export type ArchiveSchedule = (run: () => void, ms: number) => () => void;

/**
 * The host's schedule: a timer that never keeps the process alive; the
 * answer cancels it and is safe to call more than once.
 */
export const hostArchiveSchedule: ArchiveSchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface ArchiverContext {
  readonly threads: ThreadStore;
  readonly publisher: WorkspacePublisher;
  /** The service's Project lock. */
  readonly exclusive: <Value>(
    projectId: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
  /** The live Project runtimes of this process. */
  readonly runtimes: ReadonlyMap<string, ProjectRuntime>;
  /** The settings in force; read once per sweep. A rejection skips that sweep's writes. */
  readonly settings: () => Promise<AutoArchiveSettings>;
  /** The service's `oversized` helper with the sweep's operation name (D27). */
  readonly oversized: (
    fields: Readonly<Record<string, string>>,
  ) => (error: unknown) => never;
  readonly schedule: ArchiveSchedule;
  readonly log: Log;
}

export interface Archiver {
  /**
   * Holds one view of `threadId` until the answer is disposed (idempotent).
   * `end` ends the caller's stream; the archiver calls it on drain. A view
   * taken after `drain` is ended at once with `unavailable` and holds
   * nothing. The first view and the end of the last each write `viewedAt`
   * without blocking the caller; the Thread counts as viewed until the
   * last write settles.
   */
  view(threadId: string, end: (error: ContractError) => void): Disposable;
  /** Whether a view of `threadId` is held. */
  viewing(threadId: string): boolean;
  /**
   * One sweep now (tests and the schedule call it). Never rejects: a failed
   * read or write is logged, and the next sweep tries again. Archives every
   * Thread the rules find due, each group in one batch under the Project's
   * lock, after deciding again from storage under that lock.
   */
  sweep(): Promise<void>;
  /** Stops sweeping and ends every open view with `unavailable` (D29). */
  drain(): void;
  /** Stops the schedule; later calls do nothing. */
  dispose(): void;
}

/** Builds an archiver; it arms its first sweep `sweepIntervalMs` after creation. */
export const createArchiver = (context: ArchiverContext): Archiver => {
  const { threads, runtimes, schedule, log } = context;
  /** Views held per Thread. */
  const counts = new Map<string, number>();
  /** End-of-view writes in flight per Thread (D5). */
  const ending = new Map<string, number>();
  /** Every open view, so a drain can end it. */
  const open = new Set<{
    readonly end: (error: ContractError) => void;
    readonly release: () => void;
  }>();
  /** When a sweep first saw each live Project (D29). */
  const seen = new Map<string, number>();
  /** Projects whose write task has not finished (D26). */
  const writing = new Set<string>();
  const armed = new Set<() => void>();
  let stopped = false;
  let draining = false;

  const bump = (map: Map<string, number>, id: string, by: number) => {
    const next = (map.get(id) ?? 0) + by;
    if (next === 0) map.delete(id);
    else map.set(id, next);
  };

  const markViewed = (threadId: string): Promise<void> =>
    threads
      .markViewed(threadId, new Date().toISOString())
      .catch((error: unknown) =>
        log.warn('Could not record a Thread view', {
          threadId,
          error: String(error),
        }),
      );

  const viewing = (threadId: string): boolean =>
    counts.has(threadId) || ending.has(threadId);

  const unavailable = () =>
    new ContractError(
      'unavailable',
      'The runtime is handing over to a new generation.',
    );

  /** The groups the rules find due by `now`, each written as one batch. */
  const dueGroups = (
    projectId: string,
    states: readonly ArchiveState[],
    settings: AutoArchiveSettings,
    now: number,
  ): readonly (readonly string[])[] => {
    const live = runtimes.get(projectId)?.threads;
    const facts = new Map(
      states.map((state) => [
        state.thread.id,
        factsOf(state, live?.get(state.thread.id), viewing(state.thread.id)),
      ]),
    );
    const records = states.map(({ thread }) => thread);
    const grouped = new Set<string>();
    const groups: string[][] = [];
    for (const root of facts.values()) {
      if (root.thread.parentThreadId !== undefined) continue;
      const descendants = [...subtreeIds(records, root.thread.id)]
        .filter((id) => id !== root.thread.id)
        .flatMap((id) => facts.get(id) ?? []);
      const due = inactiveDue(root, descendants, settings);
      if (due === undefined || due > now) continue;
      const group = [
        root.thread.id,
        ...descendants
          .filter(({ thread }) => thread.archivedAt === undefined)
          .map(({ thread }) => thread.id),
      ];
      for (const id of group) grouped.add(id);
      groups.push(group);
    }
    for (const thread of facts.values()) {
      if (grouped.has(thread.thread.id)) continue;
      const due = finishedDue(thread, settings);
      if (due !== undefined && due <= now) groups.push([thread.thread.id]);
    }
    return groups;
  };

  /** Decides again under the Project lock and writes each due group. */
  const write = (projectId: string, settings: AutoArchiveSettings) =>
    context
      .exclusive(projectId, async () => {
        const states = await threads.archiveStates(projectId);
        for (const group of dueGroups(projectId, states, settings, Date.now()))
          await writeArchive(context, projectId, group).catch(
            context.oversized({ projectId, threadId: group[0] ?? '' }),
          );
      })
      .catch((error: unknown) => {
        // `oversized` has logged a refusal over the batch limit already.
        if (!isContractError(error) || error.code !== 'limit_exceeded')
          log.error('Auto-archive failed', { projectId, error: String(error) });
      })
      .finally(() => writing.delete(projectId));

  const arm = () => {
    if (stopped || draining) return;
    const cancel = schedule(() => {
      armed.delete(cancel);
      void archiver.sweep();
    }, sweepIntervalMs);
    armed.add(cancel);
  };

  const stopSchedule = () => {
    for (const cancel of armed) cancel();
    armed.clear();
  };

  const archiver: Archiver = {
    view(threadId, end) {
      if (draining) {
        end(unavailable());
        return { dispose: () => undefined };
      }
      let held = true;
      const entry = {
        end,
        release: () => {
          if (!held) return;
          held = false;
          open.delete(entry);
          bump(counts, threadId, -1);
          if (counts.has(threadId)) return;
          bump(ending, threadId, 1);
          void markViewed(threadId).finally(() => bump(ending, threadId, -1));
        },
      };
      open.add(entry);
      bump(counts, threadId, 1);
      if (counts.get(threadId) === 1) void markViewed(threadId);
      return { dispose: entry.release };
    },

    viewing,

    async sweep() {
      if (stopped || draining) return;
      try {
        let settings: AutoArchiveSettings;
        try {
          settings = await context.settings();
        } catch (error) {
          log.warn('Could not read the auto-archive settings', {
            error: String(error),
          });
          return;
        }
        const now = Date.now();
        for (const id of seen.keys()) if (!runtimes.has(id)) seen.delete(id);
        for (const [projectId, runtime] of runtimes) {
          if (stopped || draining) return;
          const first = seen.get(projectId) ?? now;
          seen.set(projectId, first);
          if (
            runtime.closing ||
            now - first < projectGraceMs ||
            writing.has(projectId)
          )
            continue;
          let states: readonly ArchiveState[];
          try {
            states = await threads.archiveStates(projectId);
          } catch (error) {
            log.warn('Could not read the Threads to auto-archive', {
              projectId,
              error: String(error),
            });
            continue;
          }
          if (dueGroups(projectId, states, settings, now).length === 0)
            continue;
          writing.add(projectId);
          void write(projectId, settings);
        }
      } finally {
        arm();
      }
    },

    drain() {
      draining = true;
      stopSchedule();
      for (const entry of [...open]) {
        entry.end(unavailable());
        entry.release();
      }
    },

    dispose() {
      stopped = true;
      stopSchedule();
    },
  };

  arm();
  return archiver;
};

/**
 * Archives `ids` of one Project in one store commit with a new batch, sets
 * each live record, publishes each record; answers the batch and the
 * records. Shared by the sweep and the service's manual archive. Rejects as
 * the store does; then nothing is written, set or published.
 */
export const writeArchive = async (
  context: Pick<ArchiverContext, 'threads' | 'publisher' | 'runtimes'>,
  projectId: string,
  ids: readonly string[],
): Promise<{ readonly batch: string; readonly threads: readonly Thread[] }> => {
  const batch = randomUUID();
  const threads = await context.threads.archive(ids, {
    at: new Date().toISOString(),
    batch,
  });
  const live = context.runtimes.get(projectId)?.threads;
  for (const thread of threads) {
    const runtime = live?.get(thread.id);
    if (runtime !== undefined) runtime.thread = thread;
    context.publisher.threadUpdated(thread);
  }
  return { batch, threads };
};

/**
 * Host-internal: the facts the rules read about one Thread, shared by the
 * sweep and the service's manual archive. `thread`, `batch`, `restoredAt`,
 * `viewedAt` and `interrupted` come from `state`; `busy` is true when the
 * stored state is queued, running or cancelling, or when `live` (the
 * Thread's runtime here, if loaded) holds jobs, an active prompt or a
 * storage pause; `viewing` is passed through; `question` is
 * `hasQuestionForm` of the result text, false without a result.
 */
export const factsOf = (
  state: ArchiveState,
  live: ThreadRuntime | undefined,
  viewing: boolean,
): ArchiveFacts => {
  const { thread } = state;
  return {
    thread,
    ...(state.batch === undefined ? {} : { batch: state.batch }),
    ...(state.restoredAt === undefined ? {} : { restoredAt: state.restoredAt }),
    ...(state.viewedAt === undefined ? {} : { viewedAt: state.viewedAt }),
    interrupted: state.interrupted,
    busy:
      thread.state === 'queued' ||
      thread.state === 'running' ||
      thread.state === 'cancelling' ||
      (live !== undefined &&
        (live.jobs.length > 0 ||
          live.active !== undefined ||
          live.storagePending !== undefined)),
    viewing,
    question:
      thread.result !== undefined && hasQuestionForm(thread.result.text),
  };
};
