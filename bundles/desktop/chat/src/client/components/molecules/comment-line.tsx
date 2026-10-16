// One line of a comment, drawn by the composer's stack and by the user turn
// that the send flushed it into: the reader's avatar, their name, the note —
// truncated on the line, whole in the details — and the anchor with the pin's
// number (`docs/architecture/bundles/papercraft.md`, the stack's ASCII). The
// same element serves both places: in the stack it is a draft the reader can
// still edit and remove, and in the turn it is durable — the details open,
// nothing edits, because a sent comment is immutable until a new event says
// otherwise.

import { Button } from 'desktop/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { Separator } from 'desktop/ui/separator';
import { TrashIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
  /** The pin's number, from the stack's or the turn's order. */
  readonly pin: number;
}

/** Whether the element tag names the line this component draws. */
export const isChatCommentLineTag = (tag: string): boolean =>
  tag === CHAT_COMMENT_LINE_TAG;

/** The comment line's own shape: the avatar first, the pin last. */
const lineOf = (item: CommentLineItem) => ({
  author: item.author ?? READER_NAME,
  note: item.note,
  anchor: item.target === undefined ? undefined : anchorLabel(item.target),
});

/**
 * One comment line: single, truncated with an ellipsis when it runs long, and
 * opened in a popover that shows the note whole and the anchor — and, when the
 * line is a draft, edits the note and offers to drop it.
 */
export function CommentLine({
  item,
  editable = false,
  open = false,
  onNote,
  onRemove,
  onClose,
}: {
  readonly item: CommentLineItem;
  /** A draft line can be edited and removed; a durable one cannot. */
  readonly editable?: boolean;
  /** The line the surface opens, as a new comment is added to the stack. */
  readonly open?: boolean;
  /** Edits the draft's note, whole words only. */
  readonly onNote?: (note: string) => void;
  /** Removes the draft from the stack. */
  readonly onRemove?: () => void;
  /** Reports the popover closing, so the focused line can stop opening. */
  readonly onClose?: () => void;
}) {
  const { author, note, anchor } = lineOf(item);
  const [draft, setDraft] = useState(note);
  // The line the surface wants open — a comment that just joined the stack —
  // opens the same popover a click does, and closing it releases both.
  const [held, setHeld] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(note);
  }, [note]);

  useEffect(() => {
    if (open && editable) {
      setHeld(true);
      // The note is where the comment is written: a line that just joined the
      // stack opens writing in it, not reading what is not there yet.
      const focus = (): void => input.current?.focus();
      const area = input.current;

      if (area === null) requestAnimationFrame(focus);
      else focus();
    }
  }, [open, editable]);

  const label = note.length === 0 ? 'New comment' : `${author}: ${note}`;
  const aria = `Comment ${item.pin}${anchor === undefined ? '' : ` on ${anchor}`}`;

  return (
    <Popover
      open={held || open}
      onOpenChange={(next) => {
        setHeld(next);
        if (!next) onClose?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="queue-row w-full justify-start gap-2 rounded-none border-0 text-sm font-light focus-visible:ring-inset"
          aria-label={aria}
        >
          <ReaderAvatar name={author} />
          <span className="max-w-40 shrink-0 truncate">{author}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {note.length === 0 ? 'New comment' : note}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-xs text-muted-foreground">
            {anchor !== undefined && (
              <span className="truncate max-w-40">{anchor}</span>
            )}
            <span className="tabular-nums">[{item.pin}]</span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={label}
        className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 font-conversation text-sm text-foreground ring-0 duration-0"
      >
        <div className="max-h-64 overflow-y-auto p-4 whitespace-pre-wrap wrap-break-word select-text">
          {note.length === 0 ? (
            <span className="text-muted-foreground">Write a note…</span>
          ) : (
            note
          )}
        </div>
        {editable && (
          <>
            <Separator />
            <div className="flex flex-col gap-2 bg-sidebar p-4 text-xs">
              <label className="flex flex-col gap-1.5">
                <span className="text-muted-foreground">Note</span>
                <textarea
                  ref={input}
                  value={draft}
                  rows={3}
                  className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm font-light outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    onNote?.(event.target.value);
                  }}
                  placeholder="What should be different?"
                />
              </label>
              {onRemove !== undefined && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="justify-start gap-1.5 px-0 font-light text-muted-foreground"
                  onClick={() => onRemove()}
                >
                  <TrashIcon data-icon="inline-start" />
                  Remove from this send
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
