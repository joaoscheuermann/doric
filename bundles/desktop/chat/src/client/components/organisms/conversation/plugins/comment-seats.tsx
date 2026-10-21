// The inline comment seats as a view of the composer's stack: every stack item
// that names a seat stands at it, by its id, while its turn is in the
// transcript, beside the seats the reader opened and still holds
// (`seat-claims.ts`). A conversation that mounts again — another Thread and
// back, a reload — seats the comments the stack still holds, with their
// highlight and their note; an undo that took a seat away gets it back, and one
// that brought a removed or sent comment's seat back loses it again
// (`planSeats`).
//
// The work runs only when it can change something: the seats the stack and
// the claims ask for changed (not a note's words), a seat was created or
// destroyed, or a turn was while a wanted comment waits for its turn — never
// for a streamed delta, a keystroke in the prompt or a note, or a caret move.
// Its own edits stay out of the undo history.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  HISTORIC_TAG,
  type NodeMutation,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { useContext, useEffect } from 'react';

import {
  planSeats,
  type SeatWant,
  seatWantOf,
  seatWantsKey,
} from '../../../../domain/comment-seats.js';
import { ConversationThreadContext } from '../../../../hooks/use-live-terminal.js';
import { composerStackStore } from '../../../../stores/composer-stack.js';
import { $agentTurns, AgentTurnNode } from '../nodes/agent-turn-node.js';
import { CommentSeatNode } from '../nodes/comment-seat-node.js';
import { claimedSeats } from './seat-claims.js';

/** Whether a batch of mutations created or destroyed a node. */
const createdOrDestroyed = (
  mutations: ReadonlyMap<string, NodeMutation>,
): boolean => [...mutations.values()].some((change) => change !== 'updated');

/** Keeps the transcript's seats in line with the stack and the reader's claims. */
export function CommentSeats() {
  const [editor] = useLexicalComposerContext();
  const thread = useContext(ConversationThreadContext);

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
      const wanted: SeatWant[] = [
        ...composerStackStore
          .getState()
          .stack(scope.id)
          .flatMap((item) => {
            const want = seatWantOf(item);
            return want === undefined ? [] : [want];
          }),
        ...claimedSeats(editor),
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
            turns.find((turn) => turn.__turnKey === want.turn)?.openSeat(want);
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
      unregisterSeats();
      unregisterTurns();
      unsubscribe();
      composerStackStore.getState().release(scope.id);
    };
  }, [editor, thread]);

  return null;
}
