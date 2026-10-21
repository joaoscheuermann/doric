// One comment, drawn by the composer's stack inside the prompt and by the user
// turn the send flushed it into: a card whose first line is the comment's
// context — the paragraph its words were selected from, on one line truncated
// with an ellipsis, the selected words highlighted (`domain/comment-excerpt`)
// — and, nested in it, the comment itself: the author's avatar, `↩` when it
// answers another comment, and the note, framed in the theme's primary colour
// (1px around, 3px on the left, square, as the inline comment in the answer).
// While the card is hovered, or holds the keyboard's focus, a small arrow
// closes the context line: "go to" the passage the comment is about, which the
// card's owner decides (`useGoToComment`). The card itself never edits: the
// stack hands it the note's own editing host in place of the read-only text,
// and a sent comment is immutable until a new event says otherwise.

import { Button } from 'desktop/ui/button';
import { ArrowUpLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { CHAT_COMMENT_LINE_TAG } from '../../../contracts/index.js';
import type { Excerpt } from '../../domain/comment-excerpt.js';
import { anchorLabel } from '../../domain/composer-stack.js';
import { READER_NAME } from '../../domain/conversation-authors.js';
import { ReaderAvatar } from './reader-avatar.js';

/** What one comment line draws. */
export interface CommentLineItem {
  readonly author?: string;
  readonly note: string;
  /** The comment's target, for the label a screen reader hears. */
  readonly target?: unknown;
  /** The pin's number, from the owner's data or the line's order: spoken, not drawn. */
  readonly pin?: number;
  /** Whether the comment answers another one (`inReplyTo`). */
  readonly reply?: boolean;
}

/** Whether the element tag names the line this component draws. */
export const isChatCommentLineTag = (tag: string): boolean =>
  tag === CHAT_COMMENT_LINE_TAG;

/** The words a line reads out to a screen reader. */
export const commentLineLabel = (item: CommentLineItem): string => {
  const anchor =
    item.target === undefined ? undefined : anchorLabel(item.target);
  return `Comment${item.pin === undefined ? '' : ` ${item.pin}`}${anchor === undefined ? '' : ` on ${anchor}`}`;
};

/** What the card's "go to" button is named by. */
export const GO_TO_LABEL = 'Go to the commented passage';

/**
 * The context line: the paragraph, its quoted words highlighted, and the
 * "go to" arrow, shown on the card's hover or keyboard focus.
 */
function Context({
  excerpt,
  onGo,
}: {
  readonly excerpt: Excerpt | undefined;
  readonly onGo: ((from: HTMLElement) => void) | undefined;
}) {
  if (excerpt === undefined && onGo === undefined) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 px-1 leading-5 text-muted-foreground">
      <span
        data-comment-excerpt=""
        className="min-w-0 flex-1 truncate"
        title={
          excerpt === undefined
            ? undefined
            : `${excerpt.before}${excerpt.quote}${excerpt.after}`
        }
      >
        {excerpt?.before}
        {excerpt !== undefined && excerpt.quote.length > 0 && (
          <mark
            data-comment-quote=""
            className="bg-primary/18 text-primary underline decoration-primary"
          >
            {excerpt.quote}
          </mark>
        )}
        {excerpt?.after}
      </span>
      {onGo !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-comment-go=""
          aria-label={GO_TO_LABEL}
          title={GO_TO_LABEL}
          className="-my-0.5 size-5 text-muted-foreground opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 focus-visible:opacity-100"
          onClick={(event) => {
            // The card's own press (a sent comment's) does the same: once.
            event.stopPropagation();
            onGo(event.currentTarget);
          }}
        >
          <ArrowUpLeftIcon aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

/**
 * One comment: its context above, the comment framed below it. `note`
 * replaces the read-only note with the note's own editor (the stack's);
 * `excerpt` is the context the owner read for it, when there is one; `onGo`
 * takes the reader to the passage, from the card's arrow.
 */
export function CommentLine({
  item,
  excerpt,
  note,
  onGo,
}: {
  readonly item: CommentLineItem;
  readonly excerpt?: Excerpt;
  readonly onGo?: (from: HTMLElement) => void;
  /** The note's editor, in place of its read-only text. */
  readonly note?: ReactNode;
}) {
  const author = item.author ?? READER_NAME;

  return (
    <span
      data-comment-line=""
      className="group/comment flex w-full min-w-0 flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-1.5 text-left font-conversation text-sm font-light"
    >
      <Context excerpt={excerpt} onGo={onGo} />
      <span
        data-comment-frame=""
        className="flex min-w-0 items-start gap-2 rounded-none border border-l-3 border-primary px-2 py-1 focus-within:bg-primary/10"
      >
        <ReaderAvatar name={author} className="mt-0.75" />
        {item.reply === true && (
          <span aria-hidden="true" className="mt-0.5 shrink-0">
            ↩
          </span>
        )}
        {note ?? (
          <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere py-0.5 leading-normal text-muted-foreground">
            {item.note.length === 0 ? '…' : item.note}
          </span>
        )}
      </span>
    </span>
  );
}
