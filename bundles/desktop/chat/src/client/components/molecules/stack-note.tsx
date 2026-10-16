// The note of one stack line, edited where it stands: a plain-text editing
// host inside the line, with no popover and no buttons. It shows the note
// whole (wrapping) while it holds the caret, and truncated with an ellipsis
// otherwise; an empty note shows a muted placeholder.
//
// The placeholder follows the DOM's own text, not the store's note: the host
// carries `data-placeholder` only while it holds no text, so the placeholder
// never stands over the words (the conversation's placeholder rule draws any
// `data-placeholder` inside the editor, empty or not).
//
// The DOM is the note's own copy while the reader writes in it: the store's
// note — the service's echo of what was typed — reaches the DOM only while the
// caret is elsewhere, so an echo never moves the caret or drops a keystroke.

import type { ClipboardEvent, KeyboardEvent, Ref } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { insertPlainText } from '../../utility/note-caret.js';

/** The attribute every stack note carries: its item's id. */
export const STACK_NOTE_ATTRIBUTE = 'data-stack-note';

/** The note's text as the DOM holds it. */
export const noteText = (element: HTMLElement): string =>
  element.textContent ?? '';

const PLACEHOLDER = 'Write a note…';

/** Shows the placeholder while the note holds no text, and only then. */
const syncPlaceholder = (element: HTMLElement): void => {
  if (noteText(element).length === 0) {
    element.setAttribute('data-placeholder', PLACEHOLDER);
  } else {
    element.removeAttribute('data-placeholder');
  }
};

export function StackNote({
  id,
  note,
  label,
  ref,
  onText,
  onKeyDown,
}: {
  /** The stack item's id. */
  readonly id: string;
  /** The note as the store holds it. */
  readonly note: string;
  /** What a screen reader names the note by. */
  readonly label: string;
  readonly ref?: Ref<HTMLSpanElement>;
  /** Reports the note as the reader writes it. */
  readonly onText: (text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => void;
}) {
  const own = useRef<HTMLSpanElement | null>(null);

  // The store's note reaches the DOM only while the reader is not writing in
  // it: on the way in, and when another surface changed it.
  useLayoutEffect(() => {
    const element = own.current;
    if (element === null) return;
    if (element.ownerDocument.activeElement !== element) {
      if (noteText(element) !== note) element.textContent = note;
    }
    syncPlaceholder(element);
  }, [note]);

  const setRef = (element: HTMLSpanElement | null): void => {
    own.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref !== null && ref !== undefined) ref.current = element;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the note truncates with an ellipsis inside its line and wraps only while edited, which a text field cannot do
    <span
      ref={setRef}
      data-stack-note={id}
      // `true`, not `plaintext-only`: the conversation's editor leaves the
      // caret alone only inside a decorator's `contenteditable="true"` host.
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      role="textbox"
      aria-label={label}
      spellCheck={false}
      className="min-w-0 flex-1 truncate py-0.5 leading-normal text-muted-foreground caret-primary outline-none focus:overflow-visible focus:whitespace-pre-wrap focus:text-clip focus:text-foreground focus:wrap-anywhere"
      onInput={(event) => {
        const element = event.currentTarget;
        // An emptied host may keep a stray `<br>`; the placeholder needs it
        // truly empty.
        if (noteText(element).length === 0) element.replaceChildren();
        syncPlaceholder(element);
        onText(noteText(element));
      }}
      onPaste={(event: ClipboardEvent<HTMLSpanElement>) => {
        // A note is plain text: a paste keeps the words and drops the markup.
        event.preventDefault();
        insertPlainText(
          event.currentTarget,
          event.clipboardData.getData('text/plain'),
        );
        syncPlaceholder(event.currentTarget);
        onText(noteText(event.currentTarget));
      }}
      onDrop={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
    />
  );
}
