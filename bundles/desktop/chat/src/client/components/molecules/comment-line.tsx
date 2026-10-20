// One line of a comment, drawn by the composer's stack, by the user turn that
// the send flushed it into and by the top row of an agent's reply block: the
// author's avatar, `↩` before the name when the comment answers another, the
// note truncated with an ellipsis, and the anchor with the pin's number at the
// end (`docs/architecture/bundles/papercraft/README.md`, the stack's ASCII). The line
// itself never edits: the stack hands it the note's own editing host in place
// of the read-only text, and a sent comment is immutable until a new event
// says otherwise.

import { cn } from 'desktop/ui/utils';
import type { ReactNode } from 'react';

import { CHAT_COMMENT_LINE_TAG } from '../../../contracts/index.js';
import { anchorLabel } from '../../domain/composer-stack.js';
import { READER_NAME } from '../../domain/conversation-authors.js';
import { ReaderAvatar } from './reader-avatar.js';

/** What one comment line draws. */
export interface CommentLineItem {
  readonly author?: string;
  readonly note: string;
  /** The comment's target, for the anchor the line ends with. */
  readonly target?: unknown;
  /** The pin's number, from the owner's data or the line's order. */
  readonly pin?: number;
  /** Whether the comment answers another one (`inReplyTo`). */
  readonly reply?: boolean;
  /** The words the comment is about, when the line quotes a selection. */
  readonly quote?: ReactNode;
}

/** Whether the element tag names the line this component draws. */
export const isChatCommentLineTag = (tag: string): boolean =>
  tag === CHAT_COMMENT_LINE_TAG;

/** The class every comment line shares: one row, the conversation's face. */
export const COMMENT_LINE_CLASS =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-0.75 text-left font-conversation text-sm font-light';

/** The words a line reads out to a screen reader. */
export const commentLineLabel = (item: CommentLineItem): string => {
  const anchor =
    item.target === undefined ? undefined : anchorLabel(item.target);
  return `Comment${item.pin === undefined ? '' : ` ${item.pin}`}${anchor === undefined ? '' : ` on ${anchor}`}`;
};

/**
 * One comment line: single, the note truncated with an ellipsis when it runs
 * long. `note` replaces the read-only text with the note's own editor (the
 * stack's); `end` follows the pin (a user turn's state marker).
 */
export function CommentLine({
  item,
  note,
  end,
  className,
}: {
  readonly item: CommentLineItem;
  /** The note's editor, in place of its read-only text. */
  readonly note?: ReactNode;
  /** What follows the pin at the line's end. */
  readonly end?: ReactNode;
  readonly className?: string;
}) {
  const author = item.author ?? READER_NAME;
  const anchor =
    item.target === undefined ? undefined : anchorLabel(item.target);

  return (
    // A span, so the line can stand inside a button (a reply's source row).
    <span className={cn(COMMENT_LINE_CLASS, className)}>
      {item.quote === undefined ? null : (
        <span className="min-w-0 shrink truncate text-muted-foreground italic">
          {item.quote}
        </span>
      )}
      <ReaderAvatar name={author} />
      <span className="max-w-40 shrink-0 truncate">
        {item.reply === true && <span aria-hidden="true">↩ </span>}
        {author}
      </span>
      {note ?? (
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={item.note.length === 0 ? undefined : item.note}
        >
          {item.note.length === 0 ? '…' : item.note}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-xs text-muted-foreground">
        {anchor !== undefined && (
          <span className="max-w-40 truncate">{anchor}</span>
        )}
        {item.pin !== undefined && (
          <span className="tabular-nums">[{item.pin}]</span>
        )}
        {end}
      </span>
    </span>
  );
}
