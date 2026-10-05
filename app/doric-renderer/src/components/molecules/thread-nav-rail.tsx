/**
 * The thin rail inside the conversation's scroll view: one handle per prompt
 * the reader wrote, stacked down the right edge at fixed spacing and pinned to
 * the viewport's vertical centre. A handle under the reader's hover widens with
 * an animated transition and opens a popover to its left with the prompt's
 * words; the prompt the reader is looking at wears the app's primary colour.
 * A last handle throws the scroll to the prompt input. A click is the one way
 * the rail ever moves the reader's scroll.
 */
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { READER_NAME } from '@/domain/conversation-authors';
import type { Turn } from '@/domain/projector';
import { useThreadNav } from '@/hooks/use-thread-nav';
import { cn } from '@/utility/utils';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ReaderAvatar } from './reader-avatar';

/** How long a hover's popover stays open once the pointer has left its handle. */
const CLOSE_DELAY = 10;

/** One handle on the rail: the pill that widens, and the popover it opens. */
function RailHandle({
  active = false,
  hover,
  id,
  label,
  open,
  showAuthor = true,
  text,
  onClick,
}: {
  /** Whether the reader is looking at this handle's prompt, and it takes the highlight. */
  readonly active?: boolean;
  /** Opens this handle's popover while the pointer or caret rests on it. */
  readonly hover: (id: string | null) => void;
  /** The handle's identity on the rail, one with its popover. */
  readonly id: string;
  /** The handle's own name, the only thing a screen reader says. */
  readonly label: string;
  /** The handle's popover is open. */
  readonly open: boolean;
  /** Whether the preview includes the prompt's author footer. */
  readonly showAuthor?: boolean;
  /** The popover's content; a handle with no words shows no popover. */
  readonly text: string;
  readonly onClick: () => void;
}) {
  return (
    <Popover
      open={open && text !== ''}
      onOpenChange={(next) => {
        if (!next) hover(null);
      }}
    >
      <PopoverTrigger asChild>
        <div
          aria-current={active ? 'location' : undefined}
          aria-label={label}
          className="group p-1 w-4 h-2.5 cursor-pointer transition-width transition-height duration-50 ease-in-out hover:w-5"
          onBlur={() => hover(null)}
          onClick={(event) => {
            // A click only jumps. The Radix trigger toggles its popover on
            // click unless the handler says otherwise, and a toggle here would
            // close the preview the hover just opened.
            event.preventDefault();
            onClick();
          }}
          onFocus={() => hover(id)}
          onMouseEnter={() => hover(id)}
          onMouseLeave={() => hover(null)}
        >
          <div
            // className="bg-amber-300 flex h-0.5 w-2.5"
            className={cn(
              'bg-muted-foreground/30 flex h-full w-full',
              active && 'bg-primary',
            )}
          ></div>
        </div>
      </PopoverTrigger>
      {/* The popover never moves the focus on its own — both ends are cut
        deliberately. Radix focuses its content on open and refocuses the
        trigger on close; either one runs the hover handlers on its own and
        reopens what just closed, an endless blink. Focus moves only when the
        reader moves it, so `onFocus`/`onBlur` stay honest. */}
      <PopoverContent
        align="center"
        side="left"
        className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 font-conversation text-foreground ring-0 duration-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="p-4">
          <span className="line-clamp-3 whitespace-pre-wrap wrap-break-word">
            {text}
          </span>
        </div>
        {showAuthor && (
          <>
            <Separator />
            <footer className="flex items-center gap-1.5 bg-sidebar px-4 py-3 text-xs text-muted-foreground">
              <ReaderAvatar name={READER_NAME} />
              <span className="truncate">{READER_NAME}</span>
            </footer>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ThreadNavRail({
  turns,
  scrollRoot,
}: {
  /** The conversation's turns, as the surface draws them. */
  readonly turns: readonly Turn[];
  /** The conversation's scroll area root; the rail measures its viewport. */
  readonly scrollRoot: RefObject<HTMLElement | null>;
}) {
  const nav = useThreadNav({ turns, scrollRoot });
  // The one handle whose popover is open, keyed by its label. Hovering a
  // popover away closes it after a short delay, so the reader can cross the gap
  // to the popover without it vanishing under the pointer.
  const [open, setOpen] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const hover = useCallback((id: string | null) => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (id === null)
      closeTimer.current = window.setTimeout(() => setOpen(null), CLOSE_DELAY);
    else {
      closeTimer.current = null;
      setOpen(id);
    }
  }, []);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <nav
      aria-label="Thread prompts"
      className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-end"
    >
      {nav.markers.map((marker, index) => (
        <RailHandle
          key={marker.promptId}
          active={index === nav.active}
          hover={hover}
          id={marker.promptId}
          label={`Prompt ${index + 1}`}
          open={open === marker.promptId}
          text={marker.text}
          onClick={() => nav.jumpTo(marker.promptId)}
        />
      ))}
      <RailHandle
        hover={hover}
        id="prompt-input"
        label="Prompt input"
        open={open === 'prompt-input'}
        showAuthor={false}
        text="Prompt input"
        onClick={nav.jumpToInput}
      />
    </nav>
  );
}
