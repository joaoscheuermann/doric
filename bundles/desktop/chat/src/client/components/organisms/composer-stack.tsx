// The draft stack inside the prompt block: the comments the reader will send
// with the prompt, drawn as the prompt's own comment group (`CommentGroup`) —
// the reader's mark in the gutter beside an `N comments` header, then one card
// per comment with the passage it is about and its note (`CommentLine`) — and
// the prompt's words below it. The note is written in place, in the card
// itself: the header, the notes and the prompt read as the lines of one
// document, which the caret walks with the arrows, Enter and Escape, and
// Cmd/Ctrl+Backspace (or Backspace on an empty note) removes a comment
// (`noteKeyAction`).
//
// The stack sits inside the conversation's Lexical document, but its notes
// are editing hosts of their own: every event that starts in the stack is
// marked handled for the editor by the comment group (`utility/isolate`), so
// the editor's key commands, its clipboard and its click handling never act on
// a note, and the editor leaves the DOM selection alone while a note holds the
// focus.
//
// An item names the element that draws its line (`elementTag`), resolved the
// way a conversation block's element is: the chat's own tag names the card
// here, and a bundle that owns a comment kind may name its own element —
// created for the item with this line's callbacks as its properties — while a
// tag no bundle defines falls back to the same card
// (`docs/architecture/bundles/comments.md`, "Onde o comentário aparece").

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { LexicalEditor } from 'lexical';
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ComposerItem } from '../../../contracts/index.js';
import { hasWords } from '../../domain/comment-entry.js';
import { anchorBlock, commentExcerpt } from '../../domain/comment-excerpt.js';
import {
  caretAfterRemoval,
  itemData,
  type NoteCaret,
  noteKeyAction,
} from '../../domain/composer-stack.js';
import { useBlockText } from '../../hooks/use-block-text.js';
import {
  type StackThread,
  useComposerStack,
} from '../../hooks/use-composer-stack.js';
import { useGoToComment } from '../../hooks/use-go-to-comment.js';
import { composerStackStore } from '../../stores/composer-stack.js';
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
import { noteText, StackNote } from '../molecules/stack-note.js';
import { CommentGroup } from './comment-group.js';
import {
  focusPrompt,
  STACK_HEADER_SELECTOR,
  STACK_NOTES_SELECTOR,
} from './conversation/plugins/stack-caret.js';

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
const tagIsDefined = (tag: string): boolean =>
  (
    globalThis as { customElements?: { get(name: string): unknown } }
  ).customElements?.get(tag) !== undefined;

/** The stack's section, from any element inside it. */
const stackOf = (from: HTMLElement): HTMLElement | null =>
  from.closest<HTMLElement>('[data-comment-group]');

/** The stack's notes, in stack order, from any element inside the stack. */
const notesOf = (from: HTMLElement): HTMLElement[] => [
  ...(stackOf(from)?.querySelectorAll<HTMLElement>(STACK_NOTES_SELECTOR) ?? []),
];

/** Moves the caret to a note of the stack, its header, or the prompt. */
const moveCaret = (
  editor: LexicalEditor,
  from: HTMLElement,
  to: NoteCaret,
): void => {
  if (to.to === 'header') {
    stackOf(from)
      ?.querySelector<HTMLElement>(STACK_HEADER_SELECTOR)
      ?.focus({ preventScroll: true });
    return;
  }
  const note = to.to === 'note' ? notesOf(from)[to.index] : undefined;
  if (note !== undefined) placeCaret(note, to.atEnd);
  else focusPrompt(editor, to.atEnd);
};

/** What one draft comment's card is drawn from. */
interface StackLineProps {
  readonly item: ComposerItem;
  /**
   * The item's note. The stack writes a note into its item in place, so the
   * card reads it from here: a new note is a new value to draw.
   */
  readonly note: string;
  readonly pin: number;
  /** Whether the note should take the caret now. */
  readonly requested: boolean;
  readonly onNote: (id: string, note: string) => void;
  readonly onRemove: (id: string) => void;
  /** Reports the caret put where it was asked. */
  readonly onRequested: () => void;
  /** Reports the note left: what it holds goes to the service now. */
  readonly onLeave: () => void;
}

/**
 * Whether a card draws the same: one note's keystroke redraws its own card,
 * not every card of the stack.
 */
const sameLine = (before: StackLineProps, after: StackLineProps): boolean =>
  before.item.id === after.item.id &&
  before.item.author === after.item.author &&
  before.item.data === after.item.data &&
  before.note === after.note &&
  before.pin === after.pin &&
  before.requested === after.requested &&
  before.onNote === after.onNote &&
  before.onRemove === after.onRemove &&
  before.onRequested === after.onRequested &&
  before.onLeave === after.onLeave;

/** One draft comment's card, its note written in place. */
const StackLine = memo(function StackLine({
  item,
  note: written,
  pin,
  requested,
  onNote,
  onRemove,
  onRequested,
  onLeave,
}: StackLineProps) {
  const [editor] = useLexicalComposerContext();
  const note = useRef<HTMLSpanElement | null>(null);
  const data = itemData(item);
  const shape: CommentLineItem = {
    author: item.author,
    note: written,
    target: data.target,
    pin,
    reply: data.inReplyTo !== undefined,
  };
  // The paragraph the words were selected from, as the transcript draws it.
  const block = anchorBlock(data.target) ?? data.seat;
  const paragraph = useBlockText(block);
  const at = data.seat?.at;
  const excerpt = useMemo(
    () => commentExcerpt(data.target, paragraph, at),
    [data.target, paragraph, at],
  );
  const goTo = useGoToComment();
  const onGo = (from: HTMLElement): void =>
    goTo(from, {
      id: item.id,
      thread: data.inReplyTo ?? item.id,
      target: data.target,
      ...(block === undefined ? {} : { block }),
    });
  const onText = useCallback(
    (text: string): void => onNote(item.id, text),
    [onNote, item.id],
  );

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
        // Read only by the keys they decide: measuring the caret's line lays
        // the page out, which a typed character never needs.
        get empty() {
          // Whitespace alone is no note, as in the inline comment.
          return !hasWords(noteText(element));
        },
        get firstLine() {
          return caretOnFirstLine(element);
        },
        get lastLine() {
          return caretOnLastLine(element);
        },
      },
    );
    if (action.kind === 'default') return;
    event.preventDefault();
    if (action.kind === 'send') {
      // The window's chord sends (`chat.send-prompt/v1`); the note as written
      // goes with it, whatever the echo says.
      onText(noteText(element));
      return;
    }
    if (action.kind === 'remove') {
      moveCaret(editor, element, caretAfterRemoval(index, notes.length));
      onRemove(item.id);
      return;
    }
    moveCaret(editor, element, action);
  };

  // A press on the card, off its text and its arrow, puts the caret at the
  // end of the note.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const element = note.current;
    if (element === null || element.contains(event.target as Node)) return;
    if ((event.target as Element).closest('button') !== null) return;
    event.preventDefault();
    placeCaret(element, true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the press only forwards the caret to the note, which is the line's own textbox
    <div onMouseDown={onMouseDown} onBlur={onLeave} className="cursor-text">
      <CommentLine
        item={shape}
        excerpt={excerpt}
        onGo={onGo}
        note={
          <StackNote
            id={item.id}
            ref={note}
            note={written}
            label={commentLineLabel(shape)}
            onText={onText}
            onKeyDown={onKeyDown}
          />
        }
      />
    </div>
  );
}, sameLine);

/**
 * The comment stack inside the prompt: one card per item, in the order the
 * items were added, written in place while they are drafts. Empty while
 * nothing is stacked — a send that the host refuses keeps it where it was.
 */
export function ComposerStack({ thread }: { readonly thread: StackThread }) {
  const [editor] = useLexicalComposerContext();
  const stack = useComposerStack(thread);
  const [open, setOpen] = useState(true);

  // The cards' callbacks stay the same from one keystroke to the next, so a
  // card redraws only for a change of its own.
  const scope = useRef(thread);
  scope.current = thread;
  const onNote = useCallback(
    (id: string, note: string): void =>
      composerStackStore.getState().note(scope.current, id, note),
    [],
  );
  const onRemove = useCallback(
    (id: string): void =>
      composerStackStore.getState().remove(scope.current, id),
    [],
  );
  const onRequested = useCallback(
    (): void => composerStackStore.getState().focus(undefined),
    [],
  );
  const onLeave = useCallback(
    (): void => composerStackStore.getState().flushNotes(scope.current.id),
    [],
  );

  // A comment that asks for the caret is written at once: a folded stack
  // opens for it.
  const asking = stack.focused !== undefined;
  useEffect(() => {
    if (asking) setOpen(true);
  }, [asking]);

  if (stack.items.length === 0) return null;

  // The header is a stop of the caret's walk: down to the first note (the
  // prompt's start when the stack is folded), Escape back to the prompt.
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    const from = event.currentTarget;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCaret(
        editor,
        from,
        notesOf(from).length > 0
          ? { to: 'note', index: 0, atEnd: false }
          : { to: 'prompt', atEnd: false },
      );
    } else if (event.key === 'Escape') {
      event.preventDefault();
      focusPrompt(editor, true);
    }
  };

  const line = (item: ComposerItem, index: number) => {
    const pin = itemData(item).pin ?? index + 1;
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
            onNote={(note) => onNote(item.id, note)}
            onRemove={() => onRemove(item.id)}
            onClose={onRequested}
          />
        </li>
      );
    }

    // The chat's own card, and a tag nothing defines: the default card.
    return (
      <li key={item.id} className="min-w-0">
        <StackLine
          item={item}
          note={item.note}
          pin={pin}
          requested={requested}
          onNote={onNote}
          onRemove={onRemove}
          onRequested={onRequested}
          onLeave={onLeave}
        />
      </li>
    );
  };

  return (
    <CommentGroup
      count={stack.items.length}
      open={open}
      onOpenChange={setOpen}
      label="Comments to send"
      onHeaderKeyDown={onHeaderKeyDown}
    >
      <ol data-composer-stack-list="" className="flex flex-col gap-1.5">
        {stack.items.map((item, index) => line(item, index))}
      </ol>
    </CommentGroup>
  );
}
