// The draft stack above the prompt block: one line per comment, between the
// last turn and the block the reader writes in — the same single-line pattern
// the message queue above it reads (`thread-queue.tsx`), with the author's
// avatar, the note and the anchor with the pin's number at the end. The note
// is written in place, in the line itself: the notes and the prompt read as
// the lines of one document, which the caret walks with the arrows, Enter and
// Escape, and Cmd/Ctrl+Backspace (or Backspace on an empty note) removes a
// comment (`noteKeyAction`).
//
// The stack sits inside the conversation's Lexical document, but its notes
// are editing hosts of their own: every event that starts in the stack is
// marked handled for the editor (`stopLexicalPropagation`), so the editor's
// key commands, its clipboard and its click handling never act on a note, and
// the editor leaves the DOM selection alone while a note holds the focus.
//
// An item names the element that draws its line (`elementTag`), resolved the
// way a conversation block's element is: the chat's own tag names the line
// here, and a bundle that owns a comment kind may name its own element —
// created for the item with this line's callbacks as its properties — while a
// tag no bundle defines falls back to the same line
// (`docs/architecture/bundles/comments.md`, "Onde o comentário aparece").

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { type LexicalEditor, stopLexicalPropagation } from 'lexical';
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from 'react';

import type { ComposerItem } from '../../../contracts/index.js';
import {
  caretAfterRemoval,
  itemData,
  type NoteCaret,
  noteKeyAction,
} from '../../domain/composer-stack.js';
import {
  type StackThread,
  useComposerStack,
} from '../../hooks/use-composer-stack.js';
import {
  caretOnFirstLine,
  caretOnLastLine,
  placeCaret,
} from '../../utility/note-caret.js';
import {
  CommentLine,
  type CommentLineItem,
  commentLineLabel,
  isChatCommentLineTag,
} from '../molecules/comment-line.js';
import {
  noteText,
  STACK_NOTE_ATTRIBUTE,
  StackNote,
} from '../molecules/stack-note.js';
import { focusPrompt } from './conversation/plugins/stack-caret.js';

/** The properties a stack item's own element carries. */
export interface StackItemElement {
  item: ComposerItem;
  pin: number;
  /** Whether the item's note should take the caret now. */
  open: boolean;
  onNote(note: string): void;
  onRemove(): void;
  onClose(): void;
}

/**
 * The events a stack note answers itself. The editor listens for each of
 * them on its root; marking them handled keeps it from acting on a note.
 */
const NOTE_EVENTS = [
  'keydown',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionend',
  'paste',
  'cut',
  'copy',
  'drop',
  'dragstart',
  'dragover',
  'dragend',
  'pointerdown',
  'click',
] as const;

/** Assigns the properties an item's own element reads, as `ui/v1` would. */
const itemProps = (
  element: StackItemElement,
  props: Partial<StackItemElement>,
): void => {
  for (const [name, value] of Object.entries(props)) {
    // An element that takes a property reads it; one that only reads
    // attributes does not, and the line it draws stays its own.
    (element as unknown as Record<string, unknown>)[name] = value;
  }
};

/**
 * The host of one item's own element: the element the item's `elementTag`
 * names, created for this item and kept while the tag stays the same.
 */
function ItemHost({
  item,
  pin,
  tag,
  open,
  onNote,
  onRemove,
  onClose,
}: {
  readonly item: ComposerItem;
  readonly pin: number;
  readonly tag: string;
  readonly open: boolean;
  readonly onNote: (note: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<StackItemElement | undefined>(undefined);

  // The element is created once per tag: a render with new callbacks is the
  // same line, so it keeps its own state (an open editor, a caret).
  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    let created: StackItemElement;
    try {
      created = document.createElement(tag) as unknown as StackItemElement;
    } catch (error) {
      console.error(
        `Doric: the stack line <${tag}> could not be created:`,
        error,
      );
      return;
    }
    element.current = created;
    host.replaceChildren(created as unknown as Node);

    return () => {
      element.current = undefined;
      host.replaceChildren();
    };
  }, [tag]);

  // Every render hands the element its current properties; declared after
  // the creation, so a new element gets them in the same commit.
  useEffect(() => {
    if (element.current === undefined) return;
    itemProps(element.current, { item, pin, open, onNote, onRemove, onClose });
  });

  return <div ref={frame} className="contents" />;
}

/** Whether an element tag is defined in this window (`ui/v1` defines them). */
const tagIsDefined = (tag: string): boolean => {
  if (isChatCommentLineTag(tag)) return true;
  return (
    (
      globalThis as { customElements?: { get(name: string): unknown } }
    ).customElements?.get(tag) !== undefined
  );
};

/**
 * Makes every event that starts in the stack the stack's own, never the
 * editor's (see the file's head), for as long as the stack stands.
 */
const isolate = (element: HTMLElement | null): (() => void) | undefined => {
  if (element === null) return undefined;
  for (const name of NOTE_EVENTS)
    element.addEventListener(name, stopLexicalPropagation);
  return () => {
    for (const name of NOTE_EVENTS)
      element.removeEventListener(name, stopLexicalPropagation);
  };
};

/** The stack's notes, in stack order, from any element inside the stack. */
const notesOf = (from: HTMLElement): HTMLElement[] => [
  ...(from
    .closest('[data-composer-stack-list]')
    ?.querySelectorAll<HTMLElement>(`[${STACK_NOTE_ATTRIBUTE}]`) ?? []),
];

/** Moves the caret to a note of the stack, or to the prompt. */
const moveCaret = (
  editor: LexicalEditor,
  notes: readonly HTMLElement[],
  to: NoteCaret,
): void => {
  const note = to.to === 'note' ? notes[to.index] : undefined;
  if (note !== undefined) placeCaret(note, to.atEnd);
  else focusPrompt(editor, to.atEnd);
};

/** One draft line, its note written in place. */
function StackLine({
  item,
  pin,
  requested,
  onNote,
  onRemove,
  onRequested,
}: {
  readonly item: ComposerItem;
  readonly pin: number;
  /** Whether the note should take the caret now. */
  readonly requested: boolean;
  readonly onNote: (note: string) => void;
  readonly onRemove: () => void;
  /** Reports the caret put where it was asked. */
  readonly onRequested: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const note = useRef<HTMLSpanElement | null>(null);
  const data = itemData(item);
  const shape: CommentLineItem = {
    author: item.author,
    note: item.note,
    target: data.target,
    pin,
    reply: data.inReplyTo !== undefined,
  };

  // A comment that just joined the stack is written at once: its note takes
  // the caret as soon as its line stands.
  useEffect(() => {
    if (!requested || note.current === null) return;
    placeCaret(note.current, true);
    onRequested();
  }, [requested, onRequested]);

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const element = event.currentTarget;
    const notes = notesOf(element);
    const index = notes.indexOf(element);
    const action = noteKeyAction(
      {
        key: event.key,
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
      },
      {
        index,
        count: notes.length,
        empty: noteText(element).length === 0,
        firstLine: caretOnFirstLine(element),
        lastLine: caretOnLastLine(element),
      },
    );
    if (action.kind === 'default') return;
    event.preventDefault();
    if (action.kind === 'send') {
      // The window's chord sends (`chat.send-prompt/v1`); the note as written
      // goes with it, whatever the echo says.
      onNote(noteText(element));
      return;
    }
    if (action.kind === 'remove') {
      moveCaret(editor, notes, caretAfterRemoval(index, notes.length));
      onRemove();
      return;
    }
    moveCaret(editor, notes, action);
  };

  // A press on the line, off its text, puts the caret at the end of the note.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const element = note.current;
    if (element === null || element.contains(event.target as Node)) return;
    event.preventDefault();
    placeCaret(element, true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the press only forwards the caret to the note, which is the line's own textbox
    <div onMouseDown={onMouseDown} className="cursor-text">
      <CommentLine
        item={shape}
        className="items-start hover:bg-muted focus-within:bg-primary/10 [&>:not([data-stack-note])]:mt-0.75"
        note={
          <StackNote
            id={item.id}
            ref={note}
            note={item.note}
            label={commentLineLabel(shape)}
            onText={onNote}
            onKeyDown={onKeyDown}
          />
        }
      />
    </div>
  );
}

/**
 * The comment stack above the prompt: one line per item, in the order the
 * items were added, written in place while they are drafts. Empty while
 * nothing is stacked — a send that the host refuses keeps it where it was.
 */
export function ComposerStack({ thread }: { readonly thread: StackThread }) {
  const stack = useComposerStack(thread);

  if (stack.items.length === 0) return null;

  const line = (item: ComposerItem, index: number) => {
    const pin = itemData(item).pin ?? index + 1;
    const onNote = (note: string): void => stack.note(item.id, note);
    const onRemove = (): void => stack.remove(item.id);
    const onRequested = (): void => stack.focus(undefined);
    const requested = stack.focused === item.id;

    // A tag another bundle defines draws its own line, with the item and
    // this line's callbacks as the element's properties.
    if (
      !isChatCommentLineTag(item.elementTag) &&
      tagIsDefined(item.elementTag)
    ) {
      return (
        <li key={item.id} className="min-w-0">
          <ItemHost
            item={item}
            pin={pin}
            tag={item.elementTag}
            open={requested}
            onNote={onNote}
            onRemove={onRemove}
            onClose={onRequested}
          />
        </li>
      );
    }

    // The chat's own line, and a tag nothing defines: the default line.
    return (
      <li key={item.id} className="min-w-0">
        <StackLine
          item={item}
          pin={pin}
          requested={requested}
          onNote={onNote}
          onRemove={onRemove}
          onRequested={onRequested}
        />
      </li>
    );
  };

  return (
    <section
      ref={isolate}
      aria-label="Comments to send"
      className="mb-3 font-conversation text-sm font-light"
    >
      <ol data-composer-stack-list="" className="-mx-2.5 flex flex-col gap-px">
        {stack.items.map((item, index) => line(item, index))}
      </ol>
    </section>
  );
}
