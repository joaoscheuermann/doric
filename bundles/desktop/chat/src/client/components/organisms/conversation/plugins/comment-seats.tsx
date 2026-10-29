// The inline comment seats as a view of the composer's stack and of the
// comments sent: every stack item that names a seat stands at it, by its id,
// while its turn is in the transcript, beside the seats the reader opened and
// still holds (`seat-claims.ts`) and the comments sent on the answer
// (`sentSeatWants`), which stay where they were written. A conversation that
// mounts again — another Thread and back, a reload — seats the comments the
// stack still holds and the ones the log holds, with their highlight and their
// note; an undo that took a seat away gets it back, and one that brought a
// removed comment's seat back loses it again (`planSeats`).
//
// The work runs only when it can change something: the seats the stack, the
// claims and the sent comments ask for changed (not a note's words), a seat
// was created or destroyed, or a turn was while a wanted comment waits for its
// turn — never for a streamed delta, a keystroke in the prompt or a note, or a
// caret move. Its own edits stay out of the undo history.

import { $isListNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $hasAncestor,
  $isElementNode,
  HISTORIC_TAG,
  type NodeMutation,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { useContext, useEffect, useRef } from 'react';

import { locateQuote } from '../../../../domain/comment-highlight.js';
import {
  planSeats,
  type SeatWant,
  seatWantOf,
  seatWantsKey,
  sentSeatWants,
} from '../../../../domain/comment-seats.js';
import { useCommentThreads } from '../../../../hooks/use-comment-threads.js';
import { ConversationThreadContext } from '../../../../hooks/use-live-terminal.js';
import { composerStackStore } from '../../../../stores/composer-stack.js';
import { $agentTurns, AgentTurnNode } from '../nodes/agent-turn-node.js';
import { CommentSeatNode } from '../nodes/comment-seat-node.js';
import { claimedSeats } from './seat-claims.js';

/** Whether a batch of mutations created or destroyed a node. */
const createdOrDestroyed = (
  mutations: ReadonlyMap<string, NodeMutation>,
): boolean => [...mutations.values()].some((change) => change !== 'updated');

/**
 * Where a sent comment stands in `turn`: after the block holding the end of
 * its words or, when that block is a list, at the end of the item holding it —
 * where the reader wrote it. Words the answer no longer holds stand after the
 * block they started in.
 */
const $sentPlace = (
  turn: AgentTurnNode,
  want: SeatWant,
): Pick<SeatWant, 'after' | 'item'> => {
  const runs = turn
    .blocks()
    .slice(want.block)
    .flatMap((block, offset) => {
      if (!$isElementNode(block)) return [];
      const items = $isListNode(block) ? block.getChildren() : [];
      return block.getAllTextNodes().map((run) => {
        const item = items.findIndex(
          (entry) => run.is(entry) || $hasAncestor(run, entry),
        );
        return {
          text: run.getTextContent(),
          block: want.block + offset,
          ...(item < 0 ? {} : { item }),
        };
      });
    });
  const span = locateQuote(
    runs.map((run) => run.text),
    want.quote,
    want.at,
  );
  const end = span === undefined ? undefined : runs[span.end.segment];
  return end === undefined
    ? { after: want.block }
    : {
        after: end.block,
        ...(end.item === undefined ? {} : { item: end.item }),
      };
};

/**
 * Keeps the transcript's seats in line with the stack, the reader's claims and
 * the comments sent.
 */
export function CommentSeats() {
  const [editor] = useLexicalComposerContext();
  const thread = useContext(ConversationThreadContext);
  const threads = useCommentThreads();
  /** The seats the comments sent ask for, as the threads read now. */
  const sent = useRef<readonly SeatWant[]>([]);
  /** Asks for a walk of the transcript, once the effect below has started. */
  const kick = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    sent.current = sentSeatWants(threads);
    kick.current?.();
  }, [threads]);

  useEffect(() => {
    if (thread === null) return;
    const scope = { id: thread.threadId, projectId: thread.projectId };
    let queued = false;
    let disposed = false;
    /**
     * What the last walk of the transcript settled: the seats wanted then, and
     * whether one of them waits for a turn the transcript did not show.
     */
    let settled: { key: string; waiting: boolean } | undefined;
    /** Whether a seat, or a turn, was created or destroyed since that walk. */
    let seatsChanged = false;
    let turnsChanged = false;

    const reconcile = (): void => {
      queued = false;
      // Until the watch answers, the stack says nothing about the comments.
      if (disposed || !composerStackStore.getState().stacks.has(scope.id))
        return;
      const drafted: SeatWant[] = [
        ...composerStackStore
          .getState()
          .stack(scope.id)
          .flatMap((item) => {
            const want = seatWantOf(item);
            return want === undefined ? [] : [want];
          }),
        ...claimedSeats(editor),
      ];
      // A comment still drafted, or held by the reader, stands where they
      // wrote it; a sent one only while it is neither.
      const held = new Set(drafted.map((seat) => seat.id));
      const wanted = [
        ...drafted,
        ...sent.current.filter((seat) => !held.has(seat.id)),
      ];
      const key = seatWantsKey(wanted);
      // The same seats wanted, no seat come or gone, and no turn come or gone
      // that a wanted seat waits for: the transcript already holds them.
      const unchanged =
        settled?.key === key &&
        !seatsChanged &&
        !(turnsChanged && settled.waiting);
      seatsChanged = false;
      turnsChanged = false;
      if (unchanged) return;

      const { plan, waiting } = editor.read(() => {
        const turns = $agentTurns();
        const shown = new Set(turns.map((turn) => turn.__turnKey));
        return {
          plan: planSeats(
            wanted,
            turns.flatMap((turn) => turn.seats().map((seat) => seat.id)),
            shown,
          ),
          waiting: wanted.some((seat) => !shown.has(seat.turn)),
        };
      });
      settled = { key, waiting };
      if (plan.remove.length === 0 && plan.open.length === 0) return;

      const removed = new Set(plan.remove);
      editor.update(
        () => {
          const turns = $agentTurns();
          for (const turn of turns) {
            for (const seat of turn.seats()) {
              if (removed.has(seat.id)) seat.remove();
            }
          }
          for (const want of plan.open) {
            const turn = turns.find((shown) => shown.__turnKey === want.turn);
            if (turn === undefined) continue;
            turn.openSeat(
              want.sent === true
                ? { ...want, ...$sentPlace(turn, want) }
                : want,
            );
          }
        },
        { tag: [HISTORIC_TAG, SKIP_DOM_SELECTION_TAG] },
      );
    };

    const soon = (): void => {
      if (queued) return;
      queued = true;
      queueMicrotask(reconcile);
    };
    const onTurns = (mutations: Map<string, NodeMutation>): void => {
      if (!createdOrDestroyed(mutations)) return;
      turnsChanged = true;
      soon();
    };
    const onSeats = (mutations: Map<string, NodeMutation>): void => {
      if (!createdOrDestroyed(mutations)) return;
      seatsChanged = true;
      soon();
    };

    composerStackStore.getState().retain(scope);
    const unsubscribe = composerStackStore.subscribe(soon);
    kick.current = soon;
    const unregisterTurns = editor.registerMutationListener(
      AgentTurnNode,
      onTurns,
      { skipInitialization: true },
    );
    const unregisterSeats = editor.registerMutationListener(
      CommentSeatNode,
      onSeats,
      { skipInitialization: true },
    );
    soon();

    return () => {
      disposed = true;
      kick.current = undefined;
      unregisterSeats();
      unregisterTurns();
      unsubscribe();
      composerStackStore.getState().release(scope.id);
    };
  }, [editor, thread]);

  return null;
}
