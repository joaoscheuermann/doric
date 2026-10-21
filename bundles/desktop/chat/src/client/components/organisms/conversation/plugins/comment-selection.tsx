// The `message` comment gesture: with words of one of the agent's messages
// selected, the reader starts typing and a new comment opens at the end of the
// innermost block holding the end of the words — after a paragraph, or at the
// end of a list item, before the next — with what they typed already in it. The
// chat owns the kind — the second consumer of the composer's stack, the proof
// that the stack is not the preview's — so this is the one place that reads the
// selection: the turn and block it sits in, the words it holds and where in
// the block they start.
//
// Selecting alone draws nothing new: the platform's selection is enough. The
// first printable key (no Cmd, Ctrl or Alt), a paste or a text input the
// keyboard did not type (dictation, a replacement) over such a selection opens
// the comment: the answer's text is never edited — the gesture's default is
// prevented — and the words go to the new note, which takes the caret at once
// (`comment-entry.tsx`).
//
// An input method composes — a dead key (´ then e is é), an IME — and a
// composition cannot be prevented, so it is moved instead: the key that starts
// it (`Dead`, `Process`) opens the comment and puts the caret in its note
// before the composition begins, and the composition happens there. A
// composition no such key announced is kept out of the answer: the editor never
// hears it (`ReadOnlyBlocksPlugin` refuses it too), its committed text opens
// the comment, and the answer's block is drawn again from the chat's markdown,
// undoing what the browser wrote into it meanwhile. Every typing gesture opens
// a new comment, however many the paragraph already holds; navigation keys,
// Escape, Tab and every chord keep their own meaning. The comment flushes with
// the send, which writes the anchor, and its words stay highlighted while it
// stands (`comment-highlights.tsx`).

import { $isListNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $hasAncestor,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  HISTORIC_TAG,
  type LexicalNode,
  type PointType,
  type RangeSelection,
} from 'lexical';
import { useEffect } from 'react';
import { flushSync } from 'react-dom';

import { COMPOSER_ITEM_ID_PREFIX } from '../../../../../contracts/index.js';
import { solidLength } from '../../../../domain/comment-highlight.js';
import type { SeatWant } from '../../../../domain/comment-seats.js';
import { $agentTurn, $turnOf } from '../nodes/agent-turn-node.js';
import { $isCommentSeatNode } from '../nodes/comment-seat-node.js';
import { claimSeat } from './seat-claims.js';

/**
 * What one selected range of an agent message carries, and where it sits: the
 * seat of the comment it opens, all but the comment's id.
 */
type SelectedRange = Omit<SeatWant, 'id'>;

/** Whether `node` stands inside `parent`, itself included. */
const $inside = (node: LexicalNode, parent: LexicalNode): boolean =>
  node.is(parent) || $hasAncestor(node, parent);

/**
 * How many characters that are not whitespace stand in `block` before `point`;
 * a point that names no text counts from the block's start.
 */
const $solidBefore = (block: LexicalNode, point: PointType): number => {
  if (point.type !== 'text') return 0;
  const node = point.getNode();
  const runs = $isElementNode(block) ? block.getAllTextNodes() : [];
  let count = 0;
  for (const run of runs) {
    const text = run.getTextContent();
    if (run.is(node)) return count + solidLength(text.slice(0, point.offset));
    count += solidLength(text);
  }
  return 0;
};

/** The 0-based index of a turn's markdown block holding `node`, seats aside. */
const $blockIndex = (
  children: readonly LexicalNode[],
  node: LexicalNode,
): number => {
  const at = children.findIndex((child) => $inside(node, child));
  return children.slice(0, at).filter((child) => !$isCommentSeatNode(child))
    .length;
};

/**
 * The node the selection's words end in: its end point's, unless that point
 * stands before the first character of its text — a drag or a triple click
 * that ran onto the next block's start — when it is the last text the
 * selection still covers.
 */
const $endOf = (selection: RangeSelection): LexicalNode => {
  const end = selection.isBackward() ? selection.anchor : selection.focus;
  const node = end.getNode();
  if (end.offset > 0) return node;
  const covered = selection
    .getNodes()
    .filter(
      (candidate) =>
        $isTextNode(candidate) &&
        !candidate.is(node) &&
        candidate.getTextContent().length > 0,
    );
  return covered.at(-1) ?? node;
};

/**
 * Reads the reader's selection in the transcript, while it names text of one
 * of the agent's messages — both of its ends inside the same answer — with the
 * words it holds, the turn's own key, the 0-based index of the answer's block
 * the selection starts in and how far into that block it starts — and where
 * the comment stands: after the block holding the end of the words, or at the
 * end of the list item holding it, so a comment closes the innermost block it
 * is about. A selection dragged backwards starts at its focus. One that runs
 * into the prompt, or over several turns, is not a comment's: a key over it
 * keeps the meaning it has without comments.
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
  // only names a message while both of its ends stand in one agent turn.
  const start = selection.isBackward() ? selection.focus : selection.anchor;
  const anchor = start.getNode();
  const turn = $turnOf(anchor);

  if (turn === undefined) return undefined;
  if ($turnOf(selection.anchor.getNode()) !== turn) return undefined;
  if ($turnOf(selection.focus.getNode()) !== turn) return undefined;

  const children = turn.getChildren();
  const block = children.find((child) => $inside(anchor, child));
  const endNode = $endOf(selection);
  const endBlock = children.find((child) => $inside(endNode, child));
  const item = $isListNode(endBlock)
    ? endBlock.getChildren().findIndex((entry) => $inside(endNode, entry))
    : -1;
  const startItem = $isListNode(block)
    ? block.getChildren().findIndex((entry) => $inside(anchor, entry))
    : -1;

  return {
    turn: turn.__turnKey,
    block: $blockIndex(children, anchor),
    quote: selection.getTextContent().trim(),
    at: block === undefined ? 0 : $solidBefore(block, start),
    after: $blockIndex(children, endNode),
    ...(item < 0 ? {} : { item }),
    ...(startItem < 0 ? {} : { startItem }),
  };
};

/** Whether a key starts an input method's composition (a dead key, an IME). */
const startsComposition = (event: KeyboardEvent): boolean =>
  !event.isComposing &&
  (event.key === 'Dead' || event.key === 'Process' || event.keyCode === 229);

/** Whether a key types one character, with no chord held. */
const typesCharacter = (event: KeyboardEvent): boolean =>
  !event.isComposing &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  [...event.key].length === 1;

/**
 * Whether an event happened in the transcript's own text: its nearest editing
 * host is the editor's root, not a comment's note or a stack line.
 */
const inTranscript = (root: HTMLElement, event: Event): boolean => {
  const target = event.target as Element | null;
  const element =
    typeof target?.closest === 'function'
      ? target
      : ((target as Node | null)?.parentElement ?? null);
  return element?.closest('[contenteditable]') === root;
};

/**
 * The `message` comment gesture: typing over a selection in one of the agent's
 * messages opens a new comment closing the innermost block the words end in,
 * holding what was typed.
 */
export function CommentSelection() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    /** The selection a composition no key announced started over. */
    let composing: SelectedRange | undefined;

    /**
     * Opens a new comment for the selection (or `over`) with `typed` in it.
     * The note is drawn before this returns, holding the caret, so the next
     * key goes to it. Answers whether the words went to a comment.
     */
    const open = (typed: string, over?: SelectedRange): boolean => {
      const range = over ?? editor.read(() => $selectedRange());
      if (range === undefined) return false;

      const seat: SeatWant = {
        // The comment's id from its first moment: the stack keeps an id with
        // this prefix, so the seat, its claim and the item are one comment.
        id: `${COMPOSER_ITEM_ID_PREFIX}${globalThis.crypto.randomUUID()}`,
        ...range,
      };
      // The seat is the reader's from now until its comment is removed, so
      // nothing takes it for a stale one before its first word lands.
      claimSeat(editor, seat, typed);
      // Drawn now, not a moment later: the next key — or the composition this
      // one starts — goes to the note, which holds the caret by then.
      flushSync(() => {
        editor.update(
          () => {
            $agentTurn(seat.turn)?.openSeat(seat);
          },
          // A comment is not an edit of the prompt: undo never takes it away.
          { discrete: true, tag: HISTORIC_TAG },
        );
      });
      return true;
    };

    /** Takes the gesture away from the answer's text when it opened a comment. */
    const take = (event: Event, typed: string): void => {
      if (!open(typed)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const root = editor.getRootElement();
      if (root === null || !inTranscript(root, event)) return;
      if (typesCharacter(event)) take(event, event.key);
      // Not prevented: the composition the key starts happens in the note.
      else if (startsComposition(event)) open('');
    };
    const onBeforeInput = (event: InputEvent): void => {
      const root = editor.getRootElement();
      if (root === null || !inTranscript(root, event)) return;
      if (
        (event.inputType === 'insertText' ||
          event.inputType === 'insertReplacementText') &&
        typeof event.data === 'string' &&
        event.data.length > 0
      )
        take(event, event.data);
    };
    const onPaste = (event: ClipboardEvent): void => {
      const root = editor.getRootElement();
      if (root === null || !inTranscript(root, event)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length > 0) take(event, text);
    };
    // A composition no key announced: the editor never hears it, and its end
    // opens the comment with the committed text and redraws the answer.
    const onCompositionStart = (event: CompositionEvent): void => {
      const root = editor.getRootElement();
      if (root === null || !inTranscript(root, event)) return;
      composing = editor.read(() => $selectedRange());
      if (composing !== undefined) event.stopImmediatePropagation();
    };
    const onCompositionEnd = (event: CompositionEvent): void => {
      const over = composing;
      composing = undefined;
      if (over === undefined) return;
      event.stopImmediatePropagation();
      editor.update(
        () => {
          $agentTurn(over.turn)?.restore();
        },
        { discrete: true, tag: HISTORIC_TAG },
      );
      open(event.data ?? '', over);
    };

    const listen = (root: HTMLElement, on: boolean): void => {
      // Capture, so the editor — and the read-only answer — never see them.
      const change = on ? root.addEventListener : root.removeEventListener;
      change.call(root, 'keydown', onKeyDown as EventListener, true);
      change.call(root, 'beforeinput', onBeforeInput as EventListener, true);
      change.call(root, 'paste', onPaste as EventListener, true);
      change.call(
        root,
        'compositionstart',
        onCompositionStart as EventListener,
        true,
      );
      change.call(
        root,
        'compositionend',
        onCompositionEnd as EventListener,
        true,
      );
    };
    // The listeners leave the root before the next one, and on unregistering.
    return editor.registerRootListener((root) => {
      if (root === null) return;
      listen(root, true);
      return () => listen(root, false);
    });
  }, [editor]);

  return null;
}
