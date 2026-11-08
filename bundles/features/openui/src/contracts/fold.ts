// The program fold (openui.md D4): one pure fold per Thread and tag turns that
// tag's fences, in transcript order, into revisions of programs. It imports
// nothing from OpenUI: each owner passes lang-core's `mergeStatements` from
// its own adapter, and the `openui` client passes `isQuestion`.

import { anonymousIdentity, writtenIdentity } from './identity.js';

/** One fence, as the chat lists it (chat's `ChatFence`, D1); only these fields are read. */
export interface ProgramFence {
  readonly key: string;
  readonly info: string;
  readonly body: string;
  readonly state: 'streaming' | 'closed' | 'unterminated';
}

export interface ProgramRevision {
  readonly key: string;
  /** The fence's identity (D3): written, or the anonymous `_<n>`. */
  readonly identity: string;
  /** 1-based ordinal among the Thread's fences of this tag and identity that have a revision. */
  readonly revision: number;
  /** The full program as of this fence: completed statements merged into the previous revision. */
  readonly program: string;
  /** The previous revision's program; absent for revision 1. */
  readonly base?: string;
  /** False when the fence is `streaming` or `unterminated`. */
  readonly complete: boolean;
  /** True for a question fence: never merged, never a base. */
  readonly question: boolean;
  /** Present when `merge` threw for this fence: `program` is then `base`, unchanged. */
  readonly mergeFailed?: true;
}

/** lang-core's `mergeStatements`: `existing` with the statements of `patch` merged in by name. */
export type Merge = (existing: string, patch: string) => string;

/** True when a fence's first completed line that is not blank makes it a question fence (D21). */
export type IsQuestion = (firstLine: string) => boolean;

/** One fold per Thread and tag. */
export interface ProgramFold {
  /**
   * The revision of every fence of `fences` (one tag's fences, in transcript
   * order) that has a completed line that is not blank, by fence key; a fence
   * without one has no entry and counts toward no identity. Never throws: a
   * `merge` that throws gives that fence `mergeFailed` and `program === base`.
   *
   * What stays true: a call with a list equal by key and body to the previous
   * call's merges nothing again, and only fences from the first that differs
   * are merged; the result for a key depends only on the fences up to it.
   */
  revisions(
    fences: readonly ProgramFence[],
  ): ReadonlyMap<string, ProgramRevision>;
}

/**
 * The completed statements of a fence: the whole body when it is `closed`;
 * otherwise every line but the last when the body does not end with `\n`
 * (the last line may be half written). Pure.
 */
export const completedStatements = (fence: ProgramFence): string => {
  if (fence.state === 'closed' || fence.body.endsWith('\n')) return fence.body;
  const end = fence.body.lastIndexOf('\n');
  return end < 0 ? '' : fence.body.slice(0, end + 1);
};

/**
 * The first line of `completedStatements(fence)` that is not blank, or
 * `undefined` when there is none: then the fence has no revision yet (D4).
 * Pure.
 */
export const firstCompletedLine = (fence: ProgramFence): string | undefined =>
  completedStatements(fence)
    .split('\n')
    .find((line) => line.trim() !== '');

const sameFence = (a: ProgramFence, b: ProgramFence): boolean =>
  a.key === b.key &&
  a.body === b.body &&
  a.state === b.state &&
  a.info === b.info;

/**
 * A fold with its own memo of the last call. Without `isQuestion`, no fence
 * is a question fence. `merge` is called only inside `revisions`, at most once
 * per fence that has a base and differs from the memo.
 */
export const createProgramFold = (
  merge: Merge,
  isQuestion?: IsQuestion,
): ProgramFold => {
  let held: readonly ProgramFence[] = [];
  let heldRevisions: readonly (ProgramRevision | undefined)[] = [];

  return {
    revisions: (fences) => {
      let same = 0;
      while (
        same < fences.length &&
        same < held.length &&
        sameFence(fences[same] as ProgramFence, held[same] as ProgramFence)
      )
        same += 1;

      const counts = new Map<string, number>();
      const programs = new Map<string, string>();
      const revisions: (ProgramRevision | undefined)[] = [];
      const note = (revision: ProgramRevision): void => {
        counts.set(revision.identity, revision.revision);
        if (!revision.question)
          programs.set(revision.identity, revision.program);
      };

      fences.forEach((fence, at) => {
        if (at < same) {
          const kept = heldRevisions[at];
          revisions.push(kept);
          if (kept !== undefined) note(kept);
          return;
        }
        const first = firstCompletedLine(fence);
        if (first === undefined) {
          revisions.push(undefined);
          return;
        }
        const completed = completedStatements(fence);
        const question = isQuestion?.(first) ?? false;
        const named = question ? undefined : writtenIdentity(fence.info);
        const identity = named ?? anonymousIdentity(at + 1);
        const revision = (counts.get(identity) ?? 0) + 1;
        const base = question ? undefined : programs.get(identity);
        let program = completed;
        let mergeFailed = false;
        if (base !== undefined) {
          try {
            program = merge(base, completed);
          } catch {
            program = base;
            mergeFailed = true;
          }
        }
        const next: ProgramRevision = {
          key: fence.key,
          identity,
          revision,
          program,
          ...(base === undefined ? {} : { base }),
          complete: fence.state === 'closed',
          question,
          ...(mergeFailed ? { mergeFailed: true as const } : {}),
        };
        revisions.push(next);
        note(next);
      });

      held = fences;
      heldRevisions = revisions;
      return new Map(
        revisions.flatMap((revision) =>
          revision === undefined ? [] : [[revision.key, revision] as const],
        ),
      );
    },
  };
};

/** One owner's folds, one per Thread and tag, shared by its elements and subscriptions. */
export interface ProgramFolds {
  /**
   * The fold of `threadId` and `tag`, created by the first hold. Every holder
   * of the same Thread and tag gets the same fold while any hold is live; a
   * fold whose last hold was released is dropped one microtask later unless it
   * is held again before then. `release` is idempotent.
   */
  hold(
    threadId: string,
    tag: string,
  ): { readonly fold: ProgramFold; release(): void };
}

/** The folds of one owner, each made with `createProgramFold(merge, isQuestion)`. */
export const createProgramFolds = (
  merge: Merge,
  isQuestion?: IsQuestion,
): ProgramFolds => {
  const entries = new Map<string, { fold: ProgramFold; holds: number }>();

  return {
    hold: (threadId, tag) => {
      const id = JSON.stringify([threadId, tag]);
      let entry = entries.get(id);
      if (entry === undefined) {
        entry = { fold: createProgramFold(merge, isQuestion), holds: 0 };
        entries.set(id, entry);
      }
      const held = entry;
      held.holds += 1;
      let released = false;
      return {
        fold: held.fold,
        release: () => {
          if (released) return;
          released = true;
          held.holds -= 1;
          if (held.holds > 0) return;
          queueMicrotask(() => {
            if (held.holds === 0 && entries.get(id) === held)
              entries.delete(id);
          });
        },
      };
    },
  };
};
