// Which inline comment seats the transcript should hold, and in what order,
// stated in terms of their arguments. A seat is one comment: its identity is
// the comment's id (`comment-<uuid>`, chosen when the seat opens and kept by
// the stack item), so a block can hold any number of them. The stack is the
// record of every comment written in the answer: each of its items that names
// a seat (`data.seat`) stands at it while its turn is in the transcript, and
// the seats the reader opened and has not let go of yet stand beside them.
// Anything else the transcript holds — a seat an undo brought back, one whose
// comment was sent — goes, and a seat the transcript lost — a remount, an undo
// — comes back.

import type { ComposerItem } from '../../contracts/index.js';
import { anchorOf, isIndex, itemData, type SeatRef } from './composer-stack.js';

/** A seat the transcript should hold: which comment, where, which words. */
export interface SeatWant extends SeatRef {
  /** The comment's id, the stack item's own. */
  readonly id: string;
  readonly quote: string;
  /** How far into its block the words start, whitespace aside. */
  readonly at: number;
  /** The block the comment stands after (or in, for a list). */
  readonly after: number;
  /** The list item the comment closes, when it stands in a list. */
  readonly item?: number;
  /**
   * The item of `block` the words start in, when that block is a list: what
   * the comment's anchor names, for a reader who goes to its passage.
   */
  readonly startItem?: number;
}

/** What the transcript does to hold the seats it should. */
export interface SeatPlan {
  /** The ids of the seats it holds and should not. */
  readonly remove: readonly string[];
  /** The seats it should hold and does not, in a turn it shows. */
  readonly open: readonly SeatWant[];
}

/** Where a seat stands among the seats after the same block. */
export interface SeatPlace {
  readonly id: string;
  readonly block: number;
  readonly at: number;
}

/**
 * The seat a stack item asks for, with the words its anchor quotes and the
 * list item they start in when the anchor names one.
 */
export const seatWantOf = (item: ComposerItem): SeatWant | undefined => {
  const { seat, target } = itemData(item);
  const anchor = anchorOf(target);
  const quote = anchor?.text;
  if (seat === undefined || typeof quote !== 'string') return undefined;
  // A `message` anchor names the list item its words start in as `item`.
  const startItem = (anchor as { readonly item?: unknown } | undefined)?.item;

  return {
    id: item.id,
    turn: seat.turn,
    block: seat.block,
    quote,
    at: seat.at ?? 0,
    after: seat.after ?? seat.block,
    ...(seat.item === undefined ? {} : { item: seat.item }),
    ...(isIndex(startItem) ? { startItem } : {}),
  };
};

/**
 * What decides the seats a list of wanted seats opens: every field `planSeats`
 * and an opened seat read, so two lists with the same key seat the same
 * comments in the same places. A note's words are not part of it.
 */
export const seatWantsKey = (wanted: readonly SeatWant[]): string =>
  JSON.stringify(
    wanted.map((seat) => [
      seat.id,
      seat.turn,
      seat.block,
      seat.quote,
      seat.at,
      seat.after,
      seat.item ?? null,
      seat.startItem ?? null,
    ]),
  );

/**
 * What the transcript does so that its seats are the wanted ones: remove the
 * seats nobody wants, open the wanted ones it lacks in the turns it shows. A
 * seat it holds is never changed.
 */
export const planSeats = (
  wanted: readonly SeatWant[],
  present: readonly string[],
  turns: ReadonlySet<string>,
): SeatPlan => {
  const wantedIds = new Set(wanted.map((seat) => seat.id));
  const held = new Set(present);

  return {
    remove: present.filter((id) => !wantedIds.has(id)),
    open: wanted.filter((seat) => {
      if (held.has(seat.id) || !turns.has(seat.turn)) return false;
      held.add(seat.id);
      return true;
    }),
  };
};

/**
 * The order seats stand in: by the block they follow, then by where their
 * words start in it, so several comments on one paragraph read in the order of
 * the passages they are about; the id settles a tie.
 */
export const bySeatPlace = (left: SeatPlace, right: SeatPlace): number =>
  left.block - right.block ||
  left.at - right.at ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
