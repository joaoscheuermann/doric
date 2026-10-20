// The `message` comment gesture: selecting text in one of the agent's messages
// seats an inline entry after the paragraph the selection starts in, where the
// note about it is written. The chat owns the kind — the second consumer of the
// composer's stack, the proof that the stack is not the preview's — so this is
// the one place that reads the selection: the prompt that produced the message,
// the turn and block it sits in, and the words it holds.
//
// Selecting alone inserts nothing: the entry is the seat, and what it puts on
// the stack is written there, from its first character (`comment-entry.tsx`).
// The comment flushes with the same send, which writes the anchor.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalNode,
} from 'lexical';
import { useEffect, useRef } from 'react';

import { $isAgentTurnNode } from '../nodes/agent-turn-node.js';
import { $isCommentSeatNode } from '../nodes/comment-seat-node.js';

/** What one selected range of an agent message carries, and where it sits. */
interface SelectedRange {
  readonly promptId: string;
  readonly turn: string;
  readonly block: number;
  readonly text: string;
}

/** Whether `node` stands inside `parent`, itself included. */
const $inside = (node: LexicalNode, parent: LexicalNode): boolean => {
  for (let at: LexicalNode | null = node; at !== null; at = at.getParent()) {
    if (at === parent) return true;
  }
  return false;
};

/**
 * Reads the reader's selection in the transcript, while it names text of one
 * of the agent's messages — the prompt that produced it, the words it holds,
 * the turn's own key and the 0-based index of the answer's block the selection
 * starts in.
 */
const $selectedRange = (): SelectedRange | undefined => {
  const selection = $getSelection();

  if (
    !$isRangeSelection(selection) ||
    selection.isCollapsed() ||
    selection.getTextContent().trim().length === 0
  ) {
    return undefined;
  }

  // The transcript is the same editing host as the prompt, so the selection
  // only names a message while the block it starts in is an agent turn.
  const anchor = selection.anchor.getNode();
  const block = $getRoot()
    .getChildren()
    .find((child) => $inside(anchor, child));

  if (block === undefined || !$isAgentTurnNode(block)) return undefined;

  const children = block.getChildren();
  const at = children.findIndex((child) => $inside(anchor, child));
  const index = children
    .slice(0, at)
    .filter((child) => !$isCommentSeatNode(child)).length;

  return {
    promptId: block.__promptId,
    turn: block.__turnKey,
    block: index,
    text: selection.getTextContent().trim(),
  };
};

/**
 * The `message` comment gesture: a selection in one of the agent's messages
 * seats the inline entry after the paragraph it starts in, with the entry's
 * field taking the caret.
 */
export function CommentSelection() {
  const [editor] = useLexicalComposerContext();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The selection that already opened a seat, so it never opens a second. */
  const opened = useRef<string | undefined>(undefined);

  useEffect(() => {
    const read = (): void => {
      const range = editor.read(() => $selectedRange());
      if (range === undefined) return;

      const rangeKey = `${range.turn}:${range.block}:${range.text}`;
      if (rangeKey === opened.current) return;
      opened.current = rangeKey;

      let seatKey: string | undefined;
      editor.update(
        () => {
          const turn = $getRoot()
            .getChildren()
            .find(
              (child) =>
                $isAgentTurnNode(child) && child.__turnKey === range.turn,
            );
          if (turn === undefined || !$isAgentTurnNode(turn)) return;
          seatKey = turn.openSeat(range.block, range.text).getKey();
        },
        { discrete: true },
      );

      const key = seatKey;
      if (key === undefined) return;
      // The seat's DOM is drawn by React, so the caret waits for the render.
      setTimeout(() => {
        const element = editor.getElementByKey(key);
        if (element === null || !element.isConnected) return;
        element.querySelector<HTMLElement>('[role="textbox"]')?.focus();
      }, 0);
    };

    const unregister = editor.registerUpdateListener(() => {
      // A selection changes with every keystroke and every drag; one read per
      // settle is what the seat needs, not one per move.
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(read, 150);
    });
    read();

    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      unregister();
    };
  }, [editor]);

  return null;
}
