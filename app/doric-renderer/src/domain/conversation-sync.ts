/**
 * Bringing the conversation's blocks in step with the chat's turns.
 *
 * A conversation surface holds one block per turn and one author line per block
 * that wears one. This module plans the steps that keep the two in step: which
 * blocks to create, where a new one goes, which to refresh in place and which to
 * remove — a pure function of the keys the surface already holds and the turns
 * the chat projects, so the plan is testable without an editor.
 *
 * Creating every missing block at once is a freeze on a long transcript, so a
 * plan creates at most `creates` of them and reports `pending` while older turns
 * wait for a later pass. The newest missing turns are always the ones a pass
 * takes — the surface opens at the conversation's tail — and passes keep
 * arriving until nothing is pending, by which point the blocks stand exactly
 * where a one-shot sync would have put them. A turn that changes while older
 * turns are still being inserted needs no special case: its block is held, so
 * its step refreshes it wherever it sits, and a turn no block exists for yet is
 * created with its newest content when its pass comes.
 */
import {
  AGENT_NAME,
  type AuthorDraft,
  READER_NAME,
} from './conversation-authors';
import type { Turn } from './projector';

/**
 * A turn's identity across updates: the kind of turn it is and the event that
 * opened it. A run that keeps streaming keeps its first event, so its key is
 * stable while its text grows, which is what lets an update land on the block
 * already in the editor. The kind is part of it because one block stands in for
 * a burst of steps the reader watched as thinking and tool turns.
 */
const turnKey = (turn: Turn): string =>
  `${turn.type}:${turn.promptId}:${turn.events[0]?.sequence ?? 0}`;

/**
 * A block that reads as chrome between the run's turns rather than as a turn of
 * its own story: a lifecycle row, or the failure a prompt was closed with.
 */
const isChrome = (turn: Turn): boolean =>
  turn.type === 'lifecycle' ||
  turn.type === 'failure' ||
  turn.type === 'queued';

/**
 * The author line a turn trails, or `null` when it wears none. The reader's own
 * turn always wears one. So does the agent, but only on the last turn of its run
 * — the one before the next user turn — so the line trails the run's whole
 * reasoning, tool calls and answer rather than its first turn. A lifecycle or
 * failure row wears none and does not end the run a line trails, so a pause
 * between two halves of one job leaves the line where the job ends.
 */
const authorFor = (
  turns: readonly Turn[],
  index: number,
): AuthorDraft | null => {
  const turn = turns[index];
  if (turn === undefined) return null;
  const at = turn.events.at(-1)?.createdAt;
  if (turn.type === 'user')
    // A prompt the host has not accepted yet is drawn dimmed and nameless; the
    // name arrives with the accepted turn the log holds.
    return turn.accepted && turn.delegated === undefined
      ? { role: 'user', name: READER_NAME, at }
      : null;
  if (isChrome(turn)) return null;
  let next = index + 1;
  while (next < turns.length && isChrome(turns[next])) next += 1;
  const after = turns[next];
  return after === undefined || after.type === 'user'
    ? { role: 'agent', name: AGENT_NAME, at }
    : null;
};

/** A block the sync creates: what it holds, and where it goes. */
export type SyncCreate = {
  readonly kind: 'create';
  readonly turn: Turn;
  readonly key: string;
  readonly author: AuthorDraft | null;
  /**
   * Where the block goes: after the tail of the unit `after` names — its author
   * line when it wears one — or, when nothing precedes it, before the block
   * `before` names, or at the transcript's top when both are `null`.
   */
  readonly after: string | null;
  readonly before: string | null;
};

/** A block already in the editor, refreshed where it sits. */
export type SyncUpdate = {
  readonly kind: 'update';
  readonly turn: Turn;
  readonly key: string;
  readonly author: AuthorDraft | null;
};

export type SyncStep = SyncCreate | SyncUpdate;

export type SyncPlan = {
  /** What this pass does, in the order the transcript reads. */
  readonly steps: readonly SyncStep[];
  /** The keys of the blocks whose turns the chat no longer holds. */
  readonly removals: readonly string[];
  /** Whether turns still wait for a later pass to create their blocks. */
  readonly pending: boolean;
};

/**
 * The steps that bring the blocks `held` names in step with `turns`: at most
 * `creates` new blocks per plan, always the newest missing ones, while
 * everything else that changed is applied at once. Plans applied one after
 * another — each with the keys the last one created now held — leave the blocks
 * standing where a single plan without a budget would have put them.
 */
export const syncPlan = (
  held: readonly string[],
  turns: readonly Turn[],
  creates: number,
): SyncPlan => {
  const heldKeys = new Set(held);
  const keys = turns.map(turnKey);
  const keySet = new Set(keys);

  // The turns without a block, newest first: what this pass may create.
  const missing: number[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    if (!heldKeys.has(keys[index])) missing.push(index);
  }
  const budget = Math.max(0, Math.floor(creates));
  const chosen = new Set(budget === 0 ? [] : missing.slice(-budget));

  // A create with nothing before it goes in front of the nearest block that
  // stands after it — read back to front, so each turn learns its follower.
  const before: (string | null)[] = new Array(keys.length).fill(null);
  let follower: string | null = null;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    before[index] = follower;
    if (heldKeys.has(keys[index])) follower = keys[index];
  }

  const steps: SyncStep[] = [];
  let previous: string | null = null;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const turn = turns[index];
    const author = authorFor(turns, index);
    if (chosen.has(index)) {
      steps.push({
        kind: 'create',
        turn,
        key,
        author,
        after: previous,
        before: before[index],
      });
    } else if (heldKeys.has(key)) {
      steps.push({ kind: 'update', turn, key, author });
    }
    if (heldKeys.has(key) || chosen.has(index)) previous = key;
  }

  return {
    steps,
    removals: held.filter((key) => !keySet.has(key)),
    pending: missing.length > chosen.size,
  };
};
