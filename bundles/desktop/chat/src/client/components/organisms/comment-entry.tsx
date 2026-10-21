// The inline comment entry: what typing over a selection in one of the agent's
// messages opens at the end of the innermost block holding the end of the
// words — after a paragraph, or at the end of a list item. It stands where the
// words were selected — not over the transcript, and not above the prompt — so
// the comment reads as a note about the block it closes, whose words stay
// highlighted (`conversation/plugins/comment-highlights.tsx`).
//
// The entry is one element from the first character to the send: the reader's
// avatar and the note, written and edited in place, with no quote (the
// highlight says which words) and no buttons. It mounts holding what was typed
// to open it, with the caret after it. Its first words put one item on the
// composer's stack (`chat.composer/v1`) under the comment's own id, the note
// being what was typed — the item the send flushes, which the stack inside the
// prompt also lists, editable there too. Enter commits: the comment stays as
// written and the prompt takes the caret. Shift+Enter is the browser's newline.
// Escape, and Backspace or Delete on an empty note, remove the comment — its
// item, its highlight and its seat. Leaving the note keeps a comment that holds
// words and removes one that holds none (whitespace is no words: `hasWords`);
// and once the send has flushed the item, the seat has nothing left to edit and
// leaves the transcript too. A seat drawn for an item already on the stack — a
// remounted conversation, an undo (`plugins/comment-seats.tsx`) — takes that
// item and its note as its own, and an edit made on the stack's line shows here.
//
// The entry is an editing host of its own inside the conversation's document,
// so every event that starts here is marked handled for the editor (`isolate`),
// the way the composer's stack notes are.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HISTORIC_TAG } from 'lexical';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CHAT_COMMENT_LINE_TAG,
  type ComposerItem,
  MESSAGE_KIND,
  PROMPT_SEND_EVENT,
  type PromptSendDetail,
} from '../../../contracts/index.js';
import { commentKeyAction, hasWords } from '../../domain/comment-entry.js';
import { READER_NAME } from '../../domain/conversation-authors.js';
import { ConversationThreadContext } from '../../hooks/use-live-terminal.js';
import { composerStackStore } from '../../stores/composer-stack.js';
import { isolate } from '../../utility/isolate.js';
import { placeCaret } from '../../utility/note-caret.js';
import { commentLineLabel } from '../molecules/comment-line.js';
import { ReaderAvatar } from '../molecules/reader-avatar.js';
import { noteText, StackNote } from '../molecules/stack-note.js';
import type { CommentSeatBlock } from './conversation/nodes/comment-seat-node.js';
import { releaseSeat, takeTyped } from './conversation/plugins/seat-claims.js';
import { focusPrompt } from './conversation/plugins/stack-caret.js';

/** The comment target a seat's words make: the message and the range quoted. */
const targetOf = (seat: CommentSeatBlock) => ({
  kind: MESSAGE_KIND,
  id: seat.promptId,
  anchor: {
    form: 'range' as const,
    text: seat.quote,
    turn: seat.turn,
    block: seat.block,
    // Which occurrence of repeated words was selected, for every reader of
    // the anchor (the sent card marks it too).
    at: seat.at,
    // The list item the words start in, so going to them reveals that item.
    ...(seat.startItem === undefined ? {} : { item: seat.startItem }),
  },
});

/** The item a Thread's stack holds under `id`, else `undefined`. */
const stacked = (threadId: string, id: string): ComposerItem | undefined =>
  composerStackStore
    .getState()
    .stack(threadId)
    .find((candidate) => candidate.id === id);

/** Where the caret stands in `element`, while the selection's focus is there. */
const caretIn = (
  element: HTMLElement,
): { node: Node; offset: number } | undefined => {
  const selection = element.ownerDocument.getSelection();
  const node = selection?.focusNode;
  if (node === null || node === undefined || !element.contains(node))
    return undefined;
  return { node, offset: selection?.focusOffset ?? 0 };
};

/**
 * The comment one seat draws: the reader's avatar and the note, the same
 * element while it is written, committed and edited again.
 */
export function CommentEntry({ seat }: { readonly seat: CommentSeatBlock }) {
  const [editor] = useLexicalComposerContext();
  const thread = useContext(ConversationThreadContext);
  const [text, setText] = useState('');
  const host = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLSpanElement | null>(null);
  /** The id of the stack item this entry put there, once the service answered. */
  const item = useRef<string | undefined>(undefined);
  /** The add that is out, so the first keystrokes never add twice. */
  const adding = useRef<Promise<void> | undefined>(undefined);
  /** Whether the item has been seen on the stack, so its leaving is noticed. */
  const seen = useRef(false);
  /** Set once the comment is removed, so nothing after it acts again. */
  const removed = useRef(false);
  /** The caret's place while the note holds the focus; see the effect below. */
  const caret = useRef<{ node: Node; offset: number } | undefined>(undefined);
  /** The latest seat, for the callbacks that outlive a render. */
  const current = useRef(seat);
  current.current = seat;

  useEffect(() => isolate(host.current), []);

  const scope = useMemo(
    () =>
      thread === null
        ? undefined
        : { id: thread.threadId, projectId: thread.projectId },
    [thread],
  );

  const label = commentLineLabel({ note: text, target: targetOf(seat) });

  /** The note as the reader wrote it: the DOM holds it while they write. */
  const written = (): string =>
    field.current === null ? text : noteText(field.current);

  /** Puts the item on the stack, under the comment's own id. */
  const add = (note: string): void => {
    if (scope === undefined || adding.current !== undefined) return;
    const quoted = current.current;
    const pending = composerStackStore
      .getState()
      .add(scope, {
        id: quoted.id,
        kind: MESSAGE_KIND,
        elementTag: CHAT_COMMENT_LINE_TAG,
        data: {
          target: targetOf(quoted),
          seat: {
            turn: quoted.turn,
            block: quoted.block,
            at: quoted.at,
            after: quoted.after,
            ...(quoted.item === undefined ? {} : { item: quoted.item }),
          },
        },
        author: READER_NAME,
        note,
      })
      .then((added) => {
        adding.current = undefined;
        if (added === undefined) return;
        if (removed.current) {
          // Removed while the add was out: the item it made goes too.
          composerStackStore.getState().remove(scope, added.id);
          return;
        }
        item.current = added.id;
        // The service's echo may have reached the stack before the answer.
        seen.current = stacked(scope.id, added.id) !== undefined;
        // The keystrokes written while the add was out reach the item now.
        sync();
      });
    adding.current = pending;
  };

  /** Brings the item in line with the note as written. */
  const sync = (): void => {
    if (scope === undefined || removed.current) return;
    const placed = item.current;
    const note = written();
    if (placed === undefined) {
      if (hasWords(note)) add(note);
      return;
    }
    if (stacked(scope.id, placed)?.note !== note) {
      composerStackStore.getState().note(scope, placed, note);
    }
  };

  /** Hands the service the note as written now, rather than a moment later. */
  const flush = (): void => {
    if (scope !== undefined) composerStackStore.getState().flushNotes(scope.id);
  };

  /** Reports the note's words: the first ones put the item on the stack. */
  const onText = (value: string): void => {
    setText(value);
    sync();
  };

  // The words typed over the selection to open the comment are its first:
  // the note holds them, with the caret after them, as soon as it stands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the note mounts; `onText` reads refs
  useLayoutEffect(() => {
    const element = field.current;
    const typed = takeTyped(editor, current.current.id);
    if (element === null || typed === undefined) return;
    element.textContent = typed;
    placeCaret(element, true);
    if (typed.length > 0) onText(typed);
  }, []);

  /**
   * Takes the comment out of the transcript: its claim and its seat. The
   * stack is left alone — the comment is only no longer drawn here.
   */
  const forget = (): void => {
    if (removed.current) return;
    removed.current = true;
    item.current = undefined;
    releaseSeat(editor, current.current.id);
    // Not an edit of the prompt: undo never brings it back.
    editor.update(() => current.current.discard(), { tag: HISTORIC_TAG });
  };

  /**
   * The reader removes the comment (Escape, Backspace on an empty note,
   * leaving one without words): its item leaves the stack, its seat the
   * transcript. The one place the entry takes an item off the stack.
   */
  const remove = (): void => {
    if (removed.current) return;
    const placed = item.current;
    forget();
    if (scope !== undefined && placed !== undefined) {
      composerStackStore.getState().remove(scope, placed);
    }
  };

  /**
   * Shows the stack's note while the reader is not writing here: the comment
   * as another surface — the stack's line — left it.
   */
  const mirror = (note: string): void => {
    const element = field.current;
    if (element === null || element.ownerDocument.activeElement === element)
      return;
    setText(note);
    // The DOM is the note's copy: it holds the words at once, before the
    // render, so nothing reads it empty.
    if (noteText(element) !== note) element.textContent = note;
  };

  /**
   * Takes the stack item already written under this comment's id — the seat
   * was drawn again for it — with its note, while the entry holds none.
   */
  const adopt = (): void => {
    if (scope === undefined || removed.current) return;
    if (item.current !== undefined || adding.current !== undefined) return;
    const found = stacked(scope.id, current.current.id);
    if (found === undefined) return;
    item.current = found.id;
    seen.current = true;
    mirror(found.note);
  };

  // Once the send flushed the item — or anything else took it off the stack —
  // the seat has nothing left to edit, and leaves the transcript; the stack is
  // never written for it. A stack this window no longer holds (the view is
  // unmounting, the part deactivating) says nothing about the comment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `forget` acts on refs; the subscription is the Thread's
  useEffect(() => {
    if (scope === undefined) return;
    adopt();
    return composerStackStore.subscribe((state) => {
      if (!state.stacks.has(scope.id)) return;
      adopt();
      const placed = item.current;
      if (placed === undefined || removed.current) return;
      const held = state
        .stack(scope.id)
        .find((candidate) => candidate.id === placed);
      if (held !== undefined) {
        seen.current = true;
        if (held.note !== written()) mirror(held.note);
      } else if (seen.current) forget();
    });
  }, [scope]);

  // The window's send reads the stack: a note whose item is still being added
  // goes with it once the add lands, written as the reader left it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sync` reads refs
  useEffect(() => {
    if (scope === undefined) return;
    const document = host.current?.ownerDocument;
    if (document === undefined) return;
    const onSend = (event: Event): void => {
      const detail = (event as CustomEvent<PromptSendDetail>).detail;
      if (detail?.threadId !== scope.id || removed.current) return;
      sync();
      flush();
      if (adding.current !== undefined)
        detail.waitUntil(adding.current.then(flush));
    };
    document.addEventListener(PROMPT_SEND_EVENT, onSend);
    return () => document.removeEventListener(PROMPT_SEND_EVENT, onSend);
  }, [scope]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = commentKeyAction(
      {
        key: event.key,
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
      },
      {
        empty: !hasWords(written()),
        composing: event.nativeEvent.isComposing,
      },
    );
    if (action === 'default' || action === 'newline') return;

    event.preventDefault();
    if (action === 'remove') remove();
    else {
      sync();
      flush();
    }
    focusPrompt(editor, true);
  };

  // Where the caret stands in the note while the note holds it: a redraw of
  // the answer that moves the note's element takes the focus with it, and the
  // editor's next update gives both back. Cleared once the reader has left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs only; the editor is the seat's
  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    const document = element.ownerDocument;
    const onSelection = (): void => {
      if (document.activeElement !== element) return;
      const held = caretIn(element);
      if (held !== undefined) caret.current = held;
    };
    document.addEventListener('selectionchange', onSelection);
    const unregister = editor.registerUpdateListener(() => {
      const held = caret.current;
      if (held === undefined || removed.current || !element.isConnected) return;
      const active = document.activeElement;
      if (active === element) return;
      if (active !== null && active !== document.body) return;
      // The note lost the focus to nowhere while the editor redrew: take it
      // back, the caret where it stood.
      element.focus({ preventScroll: true });
      const selection = document.getSelection();
      if (selection !== null && element.contains(held.node)) {
        selection.collapse(held.node, held.offset);
      } else placeCaret(element, true);
    });
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      unregister();
    };
  }, []);

  const onFocus = (): void => {
    const element = field.current;
    if (element === null) return;
    caret.current = caretIn(element) ?? {
      node: element,
      offset: element.childNodes.length,
    };
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    // Whatever reads the stack next — another window, another surface's
    // send — finds the note as written.
    flush();
    // The window losing the focus is not the reader leaving the comment.
    if (!event.currentTarget.ownerDocument.hasFocus()) return;
    const element = field.current;
    // Focus that went to another control is the reader leaving. Focus that
    // went nowhere may be a redraw moving the note, which the editor's update
    // gives back at once: the leaving is read a moment later, by where the
    // focus is then.
    if (next instanceof Node) caret.current = undefined;
    setTimeout(() => {
      if (removed.current) return;
      if (element !== null && element.ownerDocument.activeElement === element)
        return;
      caret.current = undefined;
      if (hasWords(written())) {
        sync();
        flush();
      } else remove();
    }, 0);
  };

  // A press on the line, off its text, puts the caret at the end of the note.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const element = field.current;
    if (element === null || element.contains(event.target as Node)) return;
    event.preventDefault();
    placeCaret(element, true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the press and the keys act on the note, the entry's own textbox
    <div
      ref={host}
      data-comment-entry=""
      className="-mx-2.5 flex cursor-text items-start gap-2 rounded-none border border-l-3 border-primary px-2.5 py-0.75 font-conversation text-sm font-light focus-within:bg-primary/10"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDown={onMouseDown}
    >
      <ReaderAvatar name={READER_NAME} className="mt-0.75" />
      <StackNote
        id={seat.id}
        ref={field}
        note={text}
        label={label}
        onText={onText}
      />
    </div>
  );
}
