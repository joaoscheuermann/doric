// The comments one prompt carries, drawn inside the reader's block: the
// composer's stack in the prompt the reader is writing, and the comments a
// sent user turn flushed. A header line — `N comments` and a chevron — sits on
// the block's first line, beside the reader's mark in the gutter (the node
// that holds the group wears it; the block below then wears none), and folds
// the comments away; then one card per comment (`CommentLine`), and the
// prompt's own words follow the group.
//
// The header is the group's only control: a press, or Enter and Space while it
// holds the focus, opens and closes it. It draws as the header's text, not as
// a button.
//
// The group stands inside the conversation's Lexical document, so it is
// isolated from the editor (`utility/isolate`): Enter on its header, or on a
// card's arrow, activates the button and never writes into the prompt.

import { cn } from 'desktop/ui/utils';
import { ChevronDownIcon } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

import { isolate } from '../../utility/isolate.js';

/** The words of the header: how many comments the group holds. */
const commentCount = (count: number): string =>
  `${count} ${count === 1 ? 'comment' : 'comments'}`;

export function CommentGroup({
  count,
  open,
  onOpenChange,
  label,
  onHeaderKeyDown,
  children,
}: {
  /** How many comments the group holds. */
  readonly count: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What a screen reader names the group by. */
  readonly label: string;
  readonly onHeaderKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** The cards, drawn while the group is open. */
  readonly children: ReactNode;
}) {
  const words = commentCount(count);

  return (
    <section
      ref={isolate}
      data-comment-group=""
      aria-label={label}
      className="mb-2 flex flex-col gap-1.5 font-conversation text-sm font-light"
    >
      <button
        type="button"
        data-comment-group-header=""
        aria-expanded={open}
        className="flex w-fit cursor-pointer items-center gap-1 leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline"
        onClick={() => onOpenChange(!open)}
        onKeyDown={onHeaderKeyDown}
      >
        {words}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && children}
    </section>
  );
}
