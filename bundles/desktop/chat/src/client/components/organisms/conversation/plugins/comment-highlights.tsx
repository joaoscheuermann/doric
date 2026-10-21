// The passages of the agent's answers that hold a comment, kept highlighted
// for as long as the comment stands — while it is written, after it is
// committed, while it is edited again — and the way back from the words to it:
// a click strictly inside a highlighted passage puts the caret at the end of
// its comment. Where passages overlap, the newest comment answers. The passage
// under the pointer shows it can be clicked: the element under the pointer
// takes `data-comment-hover` (the pointer cursor) and the passage a second
// highlight, `chat-comment-hover`, painted above the first. The passage of the
// comment being written — its note holds the focus — wears that second
// highlight too. The cursor stays on that one element, never the editor's
// root: `cursor` is inherited, so a root attribute restyles every element of
// the transcript, each with its highlight styles, on every hover — a frame of
// over a hundred milliseconds in a long conversation.
//
// The highlight is the platform's own (the CSS Custom Highlight API): the
// ranges are painted by the conversation's sheet under one name
// (`::highlight(chat-comment)` in `styles.css`) and never touch the answer's
// text or its nodes, so the chat stays the owner of what the answer holds. A
// passage is painted one text run at a time, so a quote that runs over several
// blocks never paints the comment standing between them. Every conversation in
// the window shares the one named highlight, each adding and taking back its
// own ranges; where the platform has no such API the click still finds its
// comment.
//
// A seat's ranges are found again (`locateQuote`, from its block, its quote and
// where in the block the selection started) only when they can have moved: the
// seat is new or changed, its turn was redrawn, or the text they stood on left
// the document. An update that touches no seat's turn — a streamed delta to
// another turn, a keystroke in the prompt, a caret move — repaints nothing, and
// a transcript without seats does no work at all.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  type LexicalEditor,
  type NodeKey,
  type NodeMutation,
} from 'lexical';
import { useEffect } from 'react';

import { locateQuote } from '../../../../domain/comment-highlight.js';
import { placeCaret } from '../../../../utility/note-caret.js';
import { STACK_NOTE_ATTRIBUTE } from '../../../molecules/stack-note.js';
import { $turnOf } from '../nodes/agent-turn-node.js';
import {
  $isCommentSeatNode,
  CommentSeatNode,
} from '../nodes/comment-seat-node.js';

/** The highlight the conversation's sheet paints commented words under. */
const COMMENT_HIGHLIGHT = 'chat-comment';

/**
 * The highlight the passage under the pointer, and the one whose comment holds
 * the focus, wear on top of it.
 */
const COMMENT_HOVER_HIGHLIGHT = 'chat-comment-hover';

/** The attribute the element under the pointer takes over a passage. */
const COMMENT_HOVER_ATTRIBUTE = 'data-comment-hover';

/** `Range.START_TO_START` and `Range.END_TO_END`. */
const START_TO_START = 0;
const END_TO_END = 2;

/** One seat's painted passage: a range per text run, and the whole span. */
interface Painted {
  readonly runs: readonly Range[];
  /** From the passage's first character to its last, for the click's test. */
  readonly whole: Range;
}

/** The window's highlight registry, where the platform has one. */
interface HighlightWindow {
  readonly CSS?: { readonly highlights?: HighlightRegistry };
  readonly Highlight?: typeof Highlight;
}

/** The text runs a list of drawn blocks holds, in document order. */
const textRuns = (elements: readonly HTMLElement[]): Text[] =>
  elements.flatMap((element) => {
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    const runs: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
      // A comment standing in a list item is not the answer's text.
      if (node.parentElement?.closest('[data-comment-seat]') === null)
        runs.push(node as Text);
    return runs;
  });

/** A range over one text run, from `start` to `end`. */
const runRange = (run: Text, start: number, end: number): Range => {
  const range = run.ownerDocument.createRange();
  range.setStart(run, start);
  range.setEnd(run, end);
  return range;
};

/** The painted passage of one seat's quote, else `undefined`. */
const $passageOf = (
  editor: LexicalEditor,
  seat: CommentSeatNode,
): Painted | undefined => {
  const turn = $turnOf(seat);
  if (turn === undefined) return undefined;
  const elements = turn
    .blocks()
    .slice(seat.block)
    .map((child) => editor.getElementByKey(child.getKey()))
    .filter((element): element is HTMLElement => element !== null);
  const texts = textRuns(elements);
  const span = locateQuote(
    texts.map((run) => run.data),
    seat.quote,
    seat.at,
  );
  if (span === undefined) return undefined;

  const runs: Range[] = [];
  for (let at = span.start.segment; at <= span.end.segment; at += 1) {
    const run = texts[at];
    if (run === undefined) continue;
    const start = at === span.start.segment ? span.start.offset : 0;
    const end = at === span.end.segment ? span.end.offset : run.data.length;
    if (end > start) runs.push(runRange(run, start, end));
  }
  const first = runs[0];
  const last = runs.at(-1);
  if (first === undefined || last === undefined) return undefined;

  const whole = first.cloneRange();
  whole.setEnd(last.endContainer, last.endOffset);
  return { runs, whole };
};

/** Whether two ranges stand on the same boundary points. */
const sameRange = (left: Range, right: Range): boolean =>
  left.startContainer === right.startContainer &&
  left.startOffset === right.startOffset &&
  left.endContainer === right.endContainer &&
  left.endOffset === right.endOffset;

/** Whether two passages paint the same runs. */
const samePassage = (left: Painted, right: Painted): boolean =>
  left.runs.length === right.runs.length &&
  left.runs.every((range, index) => {
    const other = right.runs[index];
    return other !== undefined && sameRange(range, other);
  });

/** Whether the text a passage stands on is still in the document. */
const standing = (passage: Painted): boolean =>
  passage.runs.every((range) => range.startContainer.isConnected);

/**
 * Whether a passage is missing from the window's highlight — the platform's
 * registry appeared, or was cleared, after it was painted.
 */
const unshown = (
  view: HighlightWindow | null | undefined,
  passage: Painted,
): boolean => {
  const registry = view?.CSS?.highlights;
  const first = passage.runs[0];
  if (registry === undefined || first === undefined) return false;
  return registry.get(COMMENT_HIGHLIGHT)?.has(first) !== true;
};

/**
 * Takes one passage's ranges out of, or puts them into, one of the window's
 * shared highlights — the hover's painted above the passages'.
 */
const paint = (
  view: HighlightWindow | null | undefined,
  passage: Painted,
  on: boolean,
  name = COMMENT_HIGHLIGHT,
): void => {
  const registry = view?.CSS?.highlights;
  const Make = view?.Highlight;
  if (registry === undefined || Make === undefined) return;

  let highlight = registry.get(name);
  if (highlight === undefined) {
    if (!on) return;
    highlight = new Make();
    if (name === COMMENT_HOVER_HIGHLIGHT) highlight.priority = 1;
    registry.set(name, highlight);
  }
  for (const range of passage.runs) {
    if (on) highlight.add(range);
    else highlight.delete(range);
  }
};

/** The caret position under a point of the window, where the platform says. */
const caretAt = (
  document: Document,
  x: number,
  y: number,
): { readonly node: Node; readonly offset: number } | undefined => {
  const platform = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = platform.caretPositionFromPoint?.(x, y);
  if (position !== null && position !== undefined)
    return { node: position.offsetNode, offset: position.offset };
  const range = platform.caretRangeFromPoint?.(x, y);
  return range === null || range === undefined
    ? undefined
    : { node: range.startContainer, offset: range.startOffset };
};

/**
 * Whether a DOM point stands strictly inside a passage: a caret on either of
 * its edges — a click on the half-character beside it — is outside.
 */
const inside = (passage: Painted, node: Node, offset: number): boolean => {
  try {
    const point = passage.whole.startContainer.ownerDocument?.createRange();
    if (point === undefined) return false;
    point.setStart(node, offset);
    return (
      passage.whole.compareBoundaryPoints(START_TO_START, point) < 0 &&
      passage.whole.compareBoundaryPoints(END_TO_END, point) > 0
    );
  } catch {
    return false;
  }
};

/** The comment seat an event started inside — its note, its avatar — if any. */
const seatOf = (target: EventTarget | null): Element | null =>
  typeof (target as Element | null)?.closest === 'function'
    ? (target as Element).closest('[data-comment-seat]')
    : null;

/** Whether an event started inside a comment seat. */
const inSeat = (target: EventTarget | null): boolean => seatOf(target) !== null;

/**
 * Keeps every commented passage highlighted, shows the one under the pointer
 * as clickable, and takes a click on one to its comment.
 */
export function CommentHighlights() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    /** The seats the transcript holds, kept by their mutations. */
    const seats = new Set<NodeKey>();
    /** Seats created or changed since the last paint. */
    const changed = new Set<NodeKey>();
    const painted = new Map<NodeKey, Painted>();
    /** When each seat was created, so the newest comment answers a click. */
    const born = new Map<NodeKey, number>();
    let births = 0;
    /** The passage under the pointer, painted as clickable. */
    let hovered: NodeKey | undefined;
    /** The seat whose note holds the focus. */
    let focused: NodeKey | undefined;
    /** The passages painted in the hover highlight, as they were painted. */
    const lit = new Map<NodeKey, Painted>();
    /** The pointer's last place, read once per frame. */
    let pointer: { x: number; y: number } | undefined;
    /** The element the pointer was last over. */
    let over: Element | null = null;
    /** The element wearing the pointer cursor, if any. */
    let pointed: Element | null = null;
    let frame: number | undefined;
    /** The root the click is heard on, and the window it paints in. */
    let root: HTMLElement | null = null;

    const viewOf = (): HighlightWindow | null | undefined =>
      root?.ownerDocument.defaultView as HighlightWindow | null | undefined;

    /**
     * Paints the hover highlight over the passages that should wear it — the
     * one under the pointer and the one whose comment holds the focus — as
     * they are painted now, and takes it off every other.
     */
    const relight = (): void => {
      const wanted = new Set([hovered, focused]);
      for (const [key, passage] of lit) {
        if (wanted.has(key) && painted.get(key) === passage) continue;
        paint(viewOf(), passage, false, COMMENT_HOVER_HIGHLIGHT);
        lit.delete(key);
      }
      for (const key of wanted) {
        const passage = key === undefined ? undefined : painted.get(key);
        if (key === undefined || passage === undefined || lit.has(key))
          continue;
        paint(viewOf(), passage, true, COMMENT_HOVER_HIGHLIGHT);
        lit.set(key, passage);
      }
      point();
    };

    /**
     * Gives the pointer cursor to the element under the pointer while it is
     * over a passage, and takes it from the element that wore it before.
     */
    const point = (): void => {
      const next = hovered !== undefined && painted.has(hovered) ? over : null;
      if (next === pointed) return;
      pointed?.removeAttribute(COMMENT_HOVER_ATTRIBUTE);
      next?.setAttribute(COMMENT_HOVER_ATTRIBUTE, '');
      pointed = next;
    };

    /** Paints `key`'s passage as the one under the pointer, or none. */
    const hover = (key: NodeKey | undefined): void => {
      if (key === hovered) return;
      hovered = key;
      relight();
    };

    /** Paints `key`'s passage as the one whose comment holds the focus. */
    const focus = (key: NodeKey | undefined): void => {
      if (key === focused) return;
      focused = key;
      relight();
    };

    const unpaint = (key: NodeKey): void => {
      const passage = painted.get(key);
      if (passage === undefined) return;
      if (key === hovered) hovered = undefined;
      paint(viewOf(), passage, false);
      painted.delete(key);
      relight();
    };

    /**
     * The comment whose passage holds a DOM point strictly inside it; where
     * passages overlap, the newest comment's — the one the reader wrote last.
     */
    const hit = (node: Node, offset: number): NodeKey | undefined => {
      let found: NodeKey | undefined;
      for (const [key, passage] of painted) {
        if (!inside(passage, node, offset)) continue;
        if (
          found === undefined ||
          (born.get(key) ?? 0) > (born.get(found) ?? 0)
        )
          found = key;
      }
      return found;
    };

    const clear = (): void => {
      for (const key of [...painted.keys()]) unpaint(key);
    };

    /** The seat a DOM element stands in, by its key, else `undefined`. */
    const seatKeyOf = (target: EventTarget | null): NodeKey | undefined => {
      const element = seatOf(target);
      if (element === null) return undefined;
      for (const key of seats)
        if (editor.getElementByKey(key) === element) return key;
      return undefined;
    };

    /** Finds again the passages that can have moved, and repaints those. */
    const draw = (redrawn: ReadonlySet<NodeKey>): void => {
      for (const key of [...painted.keys()]) {
        if (!seats.has(key)) unpaint(key);
      }
      if (seats.size === 0 || root === null) {
        changed.clear();
        return;
      }
      editor.read(() => {
        for (const key of seats) {
          const seat = $getNodeByKey(key);
          if (!$isCommentSeatNode(seat)) continue;
          const held = painted.get(key);
          const turn = $turnOf(seat)?.getKey();
          const moved =
            held === undefined ||
            changed.has(key) ||
            (turn !== undefined && redrawn.has(turn)) ||
            !standing(held) ||
            unshown(viewOf(), held);
          if (!moved) continue;

          const next = $passageOf(editor, seat);
          if (
            held !== undefined &&
            next !== undefined &&
            samePassage(held, next) &&
            !unshown(viewOf(), held)
          )
            continue;
          unpaint(key);
          if (next === undefined) continue;
          painted.set(key, next);
          paint(viewOf(), next, true);
        }
      });
      changed.clear();
      // A seat drawn again keeps the focus in a new element, maybe under a new
      // key, without the focus ever leaving the editor.
      focused = seatKeyOf(root.ownerDocument.activeElement);
      relight();
    };

    // A click leaves a collapsed caret where it landed; a caret strictly
    // inside a painted passage is a click on its highlight. A click inside a
    // comment is the comment's own — its caret stays where it was put.
    const onClick = (event: MouseEvent): void => {
      if (
        event.button !== 0 ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        inSeat(event.target)
      )
        return;
      const selection = (
        event.currentTarget as HTMLElement
      ).ownerDocument.getSelection();
      const node = selection?.anchorNode;
      if (
        selection === null ||
        selection === undefined ||
        node === null ||
        node === undefined ||
        !selection.isCollapsed
      )
        return;
      const key = hit(node, selection.anchorOffset);
      if (key === undefined) return;
      const note = editor
        .getElementByKey(key)
        ?.querySelector<HTMLElement>(`[${STACK_NOTE_ATTRIBUTE}]`);
      if (note === null || note === undefined) return;
      event.preventDefault();
      placeCaret(note, true);
    };

    // The pointer over a passage shows it can be clicked: the pointer cursor
    // and the hover highlight. The platform paints no cursor for a highlight,
    // so the passage under the pointer is found once per frame, the way a
    // click finds it, from the caret position under the pointer.
    const onPointerFrame = (): void => {
      frame = undefined;
      const at = pointer;
      const document = root?.ownerDocument;
      if (at === undefined || document === undefined || painted.size === 0) {
        hover(undefined);
        return;
      }
      const caret = caretAt(document, at.x, at.y);
      hover(caret === undefined ? undefined : hit(caret.node, caret.offset));
      // Within one passage the pointer can pass to another element.
      point();
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (painted.size === 0 && hovered === undefined) return;
      const target = event.target as Element | null;
      over = typeof target?.setAttribute === 'function' ? target : null;
      pointer = inSeat(event.target)
        ? undefined
        : { x: event.clientX, y: event.clientY };
      const view = root?.ownerDocument.defaultView;
      if (frame !== undefined || view === null || view === undefined) return;
      frame = view.requestAnimationFrame(onPointerFrame);
    };
    const onMouseLeave = (): void => {
      pointer = undefined;
      over = null;
      hover(undefined);
    };
    // The focus moving between notes leaves one and enters the next in the
    // same task, so the highlight passes from passage to passage unseen.
    const onFocusIn = (event: FocusEvent): void =>
      focus(seatKeyOf(event.target));
    const onFocusOut = (): void => focus(undefined);
    const listen = (on: boolean): void => {
      if (root === null) return;
      const change = on ? root.addEventListener : root.removeEventListener;
      change.call(root, 'click', onClick as EventListener);
      change.call(root, 'mousemove', onMouseMove as EventListener);
      change.call(root, 'mouseleave', onMouseLeave);
      change.call(root, 'focusin', onFocusIn as EventListener);
      change.call(root, 'focusout', onFocusOut);
    };

    const unregisterSeats = editor.registerMutationListener(
      CommentSeatNode,
      (mutations: Map<NodeKey, NodeMutation>) => {
        for (const [key, change] of mutations) {
          if (change === 'destroyed') {
            seats.delete(key);
            changed.delete(key);
            born.delete(key);
          } else {
            if (!born.has(key)) {
              births += 1;
              born.set(key, births);
            }
            seats.add(key);
            changed.add(key);
          }
        }
      },
      // The seats already standing count as created.
      { skipInitialization: false },
    );
    const unregisterRoot = editor.registerRootListener((next) => {
      // The ranges painted in the old root's window leave with it.
      clear();
      listen(false);
      root = next;
      listen(true);
      for (const key of seats) changed.add(key);
      draw(new Set());
    });
    const unregisterUpdate = editor.registerUpdateListener(
      ({ dirtyElements }) => {
        if (seats.size === 0 && painted.size === 0) return;
        draw(new Set(dirtyElements.keys()));
      },
    );

    return () => {
      // The root listener hears a last `null` on unregistering, which clears
      // the ranges and the listeners; the frame's window is taken before it.
      const view = root?.ownerDocument.defaultView;
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
      frame = undefined;
      unregisterUpdate();
      unregisterRoot();
      unregisterSeats();
    };
  }, [editor]);

  return null;
}
