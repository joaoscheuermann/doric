// The draft stack above the prompt block: one line per comment, between the
// last turn and the block the reader writes in — the same single-line pattern
// the message queue above it reads (`thread-queue.tsx`), with the reader's
// avatar, the note truncated with an ellipsis, and the anchor with the pin's
// number at the end. Opening a line shows the note whole and edits it, which
// is the one place a comment is written (`Popover` + `Details`, the queue's
// own design).
//
// An item names the element that draws its line (`elementTag`), resolved the
// way a conversation block's element is: the chat's own tag names the line
// here, and a bundle that owns a comment kind names its own element — created
// for the item with this line's callbacks as its properties — while a tag no
// bundle defines falls back to the same line
// (`docs/architecture/bundles/comments.md`, "Onde o comentário aparece").

import { useEffect, useRef } from 'react';

import type { ComposerItem } from '../../../contracts/index.js';
import { itemTarget } from '../../domain/composer-stack.js';
import {
  type StackThread,
  useComposerStack,
} from '../../hooks/use-composer-stack.js';
import {
  CommentLine,
  type CommentLineItem,
  isChatCommentLineTag,
} from '../molecules/comment-line.js';

/** The properties a stack item's own element carries. */
export interface StackItemElement {
  item: ComposerItem;
  pin: number;
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

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    let created: StackItemElement | undefined;
    try {
      created = document.createElement(tag) as unknown as StackItemElement;
    } catch (error) {
      console.error(
        `Doric: the stack line <${tag}> could not be created:`,
        error,
      );
      return;
    }
    itemProps(created, { item, pin, open, onNote, onRemove, onClose });
    host.replaceChildren();
    host.appendChild(created as unknown as Node);

    return () => {
      host.replaceChildren();
    };
  }, [tag, item, pin, open, onNote, onRemove, onClose]);

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
 * The comment stack above the prompt: one line per item, in the order the
 * items were added, editable while they are drafts. Empty while nothing is
 * stacked — a send that the host refuses keeps it where it was.
 */
export function ComposerStack({ thread }: { readonly thread: StackThread }) {
  const stack = useComposerStack(thread);

  if (stack.items.length === 0) return null;

  const line = (item: ComposerItem, index: number) => {
    const shape: CommentLineItem = {
      author: item.author,
      note: item.note,
      target: itemTarget(item),
      pin: index + 1,
    };
    const key = `${item.id}:${index}`;
    const onNote = (note: string): void => stack.note(item.id, note);
    const onRemove = (): void => stack.remove(item.id);
    const onClose = (): void => stack.focus(undefined);
    const open = stack.focused === item.id;

    // A tag another bundle defines draws its own line, with the item and
    // this line's callbacks as the element's properties.
    if (
      !isChatCommentLineTag(item.elementTag) &&
      tagIsDefined(item.elementTag)
    ) {
      return (
        <li key={key} className="min-w-0">
          <ItemHost
            item={item}
            pin={index + 1}
            tag={item.elementTag}
            open={open}
            onNote={onNote}
            onRemove={onRemove}
            onClose={onClose}
          />
        </li>
      );
    }

    // The chat's own line, and a tag nothing defines: the default line.
    return (
      <li key={key} className="min-w-0">
        <CommentLine
          item={shape}
          editable
          open={open}
          onNote={onNote}
          onRemove={onRemove}
          onClose={onClose}
        />
      </li>
    );
  };

  return (
    <section
      aria-label="Comments to send"
      className="mb-5 flex flex-col gap-0.5 font-conversation text-sm font-light"
    >
      <h2 className="text-sm font-light text-foreground">Comments</h2>
      <ol className="-mx-2.5 flex flex-col gap-0.5">
        {stack.items.map((item, index) => line(item, index))}
      </ol>
    </section>
  );
}
