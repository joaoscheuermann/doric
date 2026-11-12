/**
 * The thin rail beside the conversation's scroll view: one handle per prompt
 * the reader wrote, stacked down its own column and pinned to the viewport's
 * vertical centre. A handle under the reader's hover widens with an animated
 * transition and opens a popover to its left with the prompt's words; the
 * block the reader is looking at wears the app's primary colour. The last
 * handle is a bar like the others, labelled "Go to the end": it throws the
 * scroll to the end and follows new content until the reader scrolls again.
 * The column is 26px wide, a 10px bar box between 8px of padding on each side,
 * and the surface lays it out as a sibling of the ScrollArea, not inside it.
 */

import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { ReaderAvatar } from 'desktop/ui/reader-avatar';
import { Separator } from 'desktop/ui/separator';
import { cn } from 'desktop/ui/utils';
import type { RefObject } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { READER_NAME } from '../../domain/conversation-authors.js';
import type { Turn } from '../../domain/projector.js';
import type { ThreadMarker } from '../../domain/thread-nav.js';
import { markerEmphasis } from '../../domain/thread-nav.js';
import { useThreadNav } from '../../hooks/use-thread-nav.js';

/** How long a hover's popover stays open once the pointer has left its handle. */
const CLOSE_DELAY = 250;

const HANDLE_WIDTHS = ['w-[13px]', 'w-3', 'w-[11px]', 'w-2.5'] as const;

const HANDLE_COLORS = [
  'bg-foreground',
  'bg-muted-foreground/60',
  'bg-muted-foreground/45',
  'bg-muted-foreground/30',
] as const;

/**
 * One handle on the rail: the pill that widens, and the popover it opens.
 *
 * Memoised on its props, which are values and the rail's stable callbacks: a
 * flush of deltas re-renders the rail, and the handles — one popover each,
 * dozens on a long transcript — stay as they were unless the active
 * one, the hovered cascade or an open popover moved.
 */
const RailHandle = memo(function RailHandle({
  active = false,
  emphasis = 3,
  hover,
  id,
  label,
  marker,
  onHandleHover,
  onJump,
  open,
  text,
}: {
  /** Whether the reader is looking at this handle's prompt, and it takes the highlight. */
  readonly active?: boolean;
  readonly emphasis?: ReturnType<typeof markerEmphasis>;
  /** Opens this handle's popover while the pointer or caret rests on it. */
  readonly hover: (id: string | null) => void;
  /** The handle's identity on the rail, one with its popover. */
  readonly id: string;
  /** The handle's own name, the only thing a screen reader says. */
  readonly label: string;
  /** The prompt this handle jumps to; the last handle, to the end, names none. */
  readonly marker?: ThreadMarker;
  /** Tracks pointer hover on the handle, separately from the popover. */
  readonly onHandleHover: (id: string | null) => void;
  /** Jumps to the handle's block, or to the end when it names none. */
  readonly onJump: (marker: ThreadMarker | undefined) => void;
  /** The handle's popover is open. */
  readonly open: boolean;
  /** The popover's content; a handle with no words shows no popover. */
  readonly text: string;
}) {
  return (
    <Popover
      open={open && text !== ''}
      onOpenChange={(next, details) => {
        // A click only jumps. The trigger toggles its popover on every press
        // unless the change is cancelled, and a toggle here would close the
        // preview the hover just opened; hover and focus alone open and close
        // the preview.
        if (details.reason === 'trigger-press') {
          details.cancel();
          return;
        }
        if (!next) hover(null);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-current={active ? 'location' : undefined}
            aria-label={label}
            className="group flex h-2.5 w-full cursor-pointer justify-end px-2 py-1"
            onBlur={() => hover(null)}
            onClick={() => onJump(marker)}
            onFocus={() => hover(id)}
            onMouseEnter={() => {
              onHandleHover(id);
              hover(id);
            }}
            onMouseLeave={() => {
              onHandleHover(null);
              hover(null);
            }}
          />
        }
      >
        <span
          className={cn(
            'h-full shrink-0 transition-[width,background-color] duration-150 ease-out group-hover:w-[17px] motion-reduce:transition-none',
            HANDLE_WIDTHS[emphasis],
            active ? 'bg-primary' : HANDLE_COLORS[emphasis],
          )}
        />
      </PopoverTrigger>
      {/* The popover never moves the focus on its own — both ends are cut
        deliberately. By default it focuses its popup on open and refocuses
        the trigger on close; either one runs the hover handlers on its own
        and reopens what just closed, an endless blink. Focus moves only when
        the reader moves it, so `onFocus`/`onBlur` stay honest. */}
      <PopoverContent
        align="center"
        side="left"
        className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 font-conversation text-foreground ring-0 duration-0"
        initialFocus={false}
        finalFocus={false}
        onMouseEnter={() => hover(id)}
        onMouseLeave={() => hover(null)}
        onFocusCapture={() => hover(id)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) hover(null);
        }}
      >
        <div className="p-4">
          <span className="line-clamp-3 whitespace-pre-wrap wrap-break-word">
            {text}
          </span>
        </div>
        {marker !== undefined && (
          <>
            <Separator />
            <footer className="flex min-w-0 items-center gap-1.5 bg-sidebar px-4 py-3 text-xs text-muted-foreground">
              <ReaderAvatar name={READER_NAME} />
              <span className="shrink-0">{READER_NAME}</span>
            </footer>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
});

/**
 * Renders the rail's own 26px column: 8px padding, a 10px bar box, 8px
 * padding. Place it beside the conversation's ScrollArea, inside the element
 * `root` points to. It holds one handle per `ThreadMarker`, then a final bar
 * labelled "Go to the end". With no markers, only that last bar shows. While
 * `root` is unset or holds no scroll viewport, nothing is active and clicking a
 * handle does nothing.
 */
export function ThreadNavRail({
  turns,
  root,
  navigating,
  following,
}: {
  /** The conversation's turns, as the surface draws them. */
  readonly turns: readonly Turn[];
  /** The element holding the conversation's scroll area and this rail's column. */
  readonly root: RefObject<HTMLElement | null>;
  /** Set while a jump scrolls, so the surface's scroll handlers leave it alone. */
  readonly navigating: RefObject<boolean>;
  /** Whether the conversation follows its end; the last handle turns it on. */
  readonly following: RefObject<boolean>;
}) {
  const nav = useThreadNav({ turns, root, navigating, following });
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
  const hoveredIndex =
    hoveredHandle === 'prompt-input'
      ? nav.markers.length
      : nav.markers.findIndex((marker) => marker.promptId === hoveredHandle);
  // The one handle whose popover is open, keyed by its `id`. Hovering a
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
  // One jump for every handle, so a handle's props are the same across the
  // renders that change nothing about it.
  const { jumpTo, jumpToInput } = nav;
  const jump = useCallback(
    (marker: ThreadMarker | undefined) => {
      if (marker === undefined) jumpToInput();
      else jumpTo(marker);
    },
    [jumpTo, jumpToInput],
  );

  return (
    <div className="relative w-[26px] shrink-0">
      <nav
        aria-label="Conversation trail"
        className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col"
      >
        {nav.markers.map((marker, index) => (
          <RailHandle
            key={marker.promptId}
            active={index === nav.active}
            emphasis={markerEmphasis(index, hoveredIndex)}
            hover={hover}
            id={marker.promptId}
            label={`User prompt ${index + 1}`}
            marker={marker}
            onHandleHover={setHoveredHandle}
            onJump={jump}
            open={open === marker.promptId}
            text={marker.text}
          />
        ))}
        <RailHandle
          emphasis={markerEmphasis(nav.markers.length, hoveredIndex)}
          hover={hover}
          id="prompt-input"
          label="Go to the end"
          onHandleHover={setHoveredHandle}
          onJump={jump}
          open={open === 'prompt-input'}
          text="Go to the end"
        />
      </nav>
    </div>
  );
}
