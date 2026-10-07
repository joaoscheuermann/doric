/**
 * The thin rail inside the conversation's scroll view: one handle per prompt,
 * queued receipt and subthread result, stacked down the right edge and pinned to
 * the viewport's vertical centre. A handle under the reader's hover widens with
 * an animated transition and opens a popover to its left with the prompt's
 * words; the block the reader is looking at wears the app's primary colour.
 * A last handle throws the scroll to the prompt input. A click is the one way
 * the rail ever moves the reader's scroll.
 */

import { ArrowUpRightIcon, BotIcon } from 'lucide-react';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  AGENT_NAME,
  type AuthorRole,
  READER_NAME,
} from '@/domain/conversation-authors';
import type { Turn } from '@/domain/projector';
import type { ThreadMarker } from '@/domain/thread-nav';
import { markerEmphasis } from '@/domain/thread-nav';
import { useDelegatedSource } from '@/hooks/use-delegated-source';
import { useThreadNav } from '@/hooks/use-thread-nav';
import { cn } from '@/utility/utils';

import { ReaderAvatar } from './reader-avatar';

/** How long a hover's popover stays open once the pointer has left its handle. */
const CLOSE_DELAY = 250;

const HANDLE_WIDTHS = {
  prompt: ['w-[13px]', 'w-3', 'w-[11px]', 'w-2.5'],
  result: ['w-[15px]', 'w-3.5', 'w-[13px]', 'w-3'],
} as const;

const HANDLE_COLORS = {
  ordinary: [
    'bg-foreground',
    'bg-muted-foreground/60',
    'bg-muted-foreground/45',
    'bg-muted-foreground/30',
  ],
  queued: ['bg-primary/50', 'bg-primary/35', 'bg-primary/25', 'bg-primary/20'],
} as const;

/** The child Thread that produced a result, using the same navigation as its transcript block. */
function ResultThreadLink({ threadId }: { readonly threadId: string }) {
  const source = useDelegatedSource(threadId);
  if (source.open === undefined)
    return (
      <span
        className={cn('min-w-0 truncate', source.label.mono && 'font-mono')}
        title={threadId}
      >
        {source.label.value}
      </span>
    );
  return (
    <span className="min-w-0 flex-1">
      <Button
        variant="link"
        size="xs"
        className="h-auto max-w-full min-w-0 justify-start gap-1 overflow-hidden px-0 py-0 text-xs font-normal"
        aria-label={`Open subagent tab: ${source.label.value}`}
        title={threadId}
        onClick={source.open}
      >
        <span className="min-w-0 truncate border-b border-transparent text-left group-hover/button:border-current group-focus-visible/button:border-current">
          {source.label.value}
        </span>
        <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
      </Button>
    </span>
  );
}

/** One handle on the rail: the pill that widens, and the popover it opens. */
function RailHandle({
  active = false,
  author,
  emphasis = 3,
  hover,
  id,
  label,
  kind = 'prompt',
  onHandleHover,
  open,
  text,
  threadId,
  onClick,
}: {
  /** Whether the reader is looking at this handle's prompt, and it takes the highlight. */
  readonly active?: boolean;
  /** The identity shown beneath this handle's preview, when it has one. */
  readonly author?: AuthorRole;
  readonly emphasis?: ReturnType<typeof markerEmphasis>;
  /** Opens this handle's popover while the pointer or caret rests on it. */
  readonly hover: (id: string | null) => void;
  /** The handle's identity on the rail, one with its popover. */
  readonly id: string;
  /** The handle's own name, the only thing a screen reader says. */
  readonly label: string;
  readonly kind?: ThreadMarker['kind'];
  /** Tracks pointer hover on the handle, separately from the popover. */
  readonly onHandleHover: (id: string | null) => void;
  /** The handle's popover is open. */
  readonly open: boolean;
  /** The popover's content; a handle with no words shows no popover. */
  readonly text: string;
  /** The child Thread that produced this result. */
  readonly threadId?: string;
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
        <button
          type="button"
          aria-current={active ? 'location' : undefined}
          aria-label={label}
          className="group flex h-2.5 w-6 cursor-pointer justify-end p-1"
          onBlur={() => hover(null)}
          onClick={(event) => {
            // A click only jumps. The Radix trigger toggles its popover on
            // click unless the handler says otherwise, and a toggle here would
            // close the preview the hover just opened.
            event.preventDefault();
            onClick();
          }}
          onFocus={() => hover(id)}
          onMouseEnter={() => {
            onHandleHover(id);
            hover(id);
          }}
          onMouseLeave={() => {
            onHandleHover(null);
            hover(null);
          }}
        >
          <span
            className={cn(
              'h-full shrink-0 transition-[width,background-color] duration-150 ease-out group-hover:w-[17px] motion-reduce:transition-none',
              HANDLE_WIDTHS[kind === 'result' ? 'result' : 'prompt'][emphasis],
              kind === 'queued'
                ? active && emphasis !== 0
                  ? 'bg-primary/50'
                  : HANDLE_COLORS.queued[emphasis]
                : active && emphasis !== 0
                  ? 'bg-primary'
                  : HANDLE_COLORS.ordinary[emphasis],
            )}
          />
        </button>
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
        {author !== undefined && (
          <>
            <Separator />
            <footer className="flex min-w-0 items-center gap-1.5 bg-sidebar px-4 py-3 text-xs text-muted-foreground">
              {author === 'agent' ? (
                <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
              ) : (
                <ReaderAvatar name={READER_NAME} />
              )}
              <span className="shrink-0">
                {author === 'agent' ? AGENT_NAME : READER_NAME}
              </span>
              {threadId !== undefined && (
                <>
                  <span className="shrink-0" aria-hidden="true">
                    ·
                  </span>
                  <ResultThreadLink threadId={threadId} />
                </>
              )}
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
  navigating,
}: {
  /** The conversation's turns, as the surface draws them. */
  readonly turns: readonly Turn[];
  /** The conversation's scroll area root; the rail measures its viewport. */
  readonly scrollRoot: RefObject<HTMLElement | null>;
  readonly navigating: RefObject<boolean>;
}) {
  const nav = useThreadNav({ turns, scrollRoot, navigating });
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
  const hoveredIndex =
    hoveredHandle === 'prompt-input'
      ? nav.markers.length
      : nav.markers.findIndex(
          (marker) => `${marker.kind}:${marker.promptId}` === hoveredHandle,
        );
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
      aria-label="Conversation trail"
      className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-end"
    >
      {nav.markers.map((marker, index) => {
        const id = `${marker.kind}:${marker.promptId}`;
        const label =
          marker.kind === 'result'
            ? 'Subthread result'
            : marker.kind === 'queued'
              ? 'Queued entry'
              : 'User prompt';
        return (
          <RailHandle
            key={id}
            active={index === nav.active}
            emphasis={markerEmphasis(index, hoveredIndex)}
            author={
              marker.kind === 'prompt'
                ? 'user'
                : marker.kind === 'result'
                  ? 'agent'
                  : undefined
            }
            hover={hover}
            id={id}
            kind={marker.kind}
            label={`${label} ${index + 1}`}
            onHandleHover={setHoveredHandle}
            open={open === id}
            text={marker.text}
            threadId={marker.kind === 'result' ? marker.threadId : undefined}
            onClick={() => nav.jumpTo(marker)}
          />
        );
      })}
      <RailHandle
        emphasis={markerEmphasis(nav.markers.length, hoveredIndex)}
        hover={hover}
        id="prompt-input"
        label="Prompt input"
        onHandleHover={setHoveredHandle}
        open={open === 'prompt-input'}
        text="Prompt input"
        onClick={nav.jumpToInput}
      />
    </nav>
  );
}
