// `thread-popover.tsx` — the thread of one pin, opened beside it once the pin
// holds its first comment (a draft of the stack or a sent comment), as Figma
// opens a comment.
//
// The header names the pin and where it points (`Checkout:42`, the full anchor
// as its tooltip) and carries three icon buttons: `⋯` (copy the anchor; remove
// a draft from the stack; show or hide the resolved threads), resolve/reopen
// (a sent root only) and close. Then the messages — avatar, name, when (or
// "na pilha" for a draft still in the stack) and the text, with a `⋯` per
// message on hover (copy; edit and remove for a draft) and the state chip on
// the last message once the thread awaits the reader or is resolved. Last, the
// reply row: the reader's avatar and the comment field. A reply joins the
// composer stack, answering this thread's root, and leaves with the next
// prompt — nothing is written from here.
//
// The popover is presentation: the surface decides what each action does. Its
// menus portal into the popover itself, so the canvas keeps the focus.

import { CircleCheckIcon, EllipsisIcon, XIcon } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { cn } from '../lib/utils.js';
import { PortalContainerProvider } from '../portal-container.js';
import { Avatar, authorName } from './avatar.js';
import { CommentField } from './comment-field.js';
import type { ContentPoint } from './geometry.js';
import { surfacePoint } from './pins-layer.js';
import type { ThreadState } from './threads.js';
import type { Viewport } from './viewport.js';

/** One message of a thread: a sent comment, or a draft still in the stack. */
export interface ThreadMessage {
  readonly id: string;
  readonly author?: string;
  readonly text: string;
  readonly createdAt?: string;
  readonly draft: boolean;
}

/** The popover's width, and the room it keeps from the canvas's edges. */
const POPOVER_WIDTH = 320;
const EDGE = 8;
/** The height the popover is placed for: below its pin when this fits. */
const POPOVER_HEIGHT = 300;

/**
 * Where the popover opens (surface pixels): beside its pin's tip, below it
 * when the canvas has room, else above it (anchored by its bottom edge), kept
 * inside the canvas with an 8px edge.
 */
export const popoverPlacement = (
  at: ContentPoint,
  area: { readonly width: number; readonly height: number },
):
  | { readonly left: number; readonly top: number }
  | { readonly left: number; readonly bottom: number } => {
  const width = Math.min(POPOVER_WIDTH, Math.max(0, area.width - 2 * EDGE));
  const left = Math.max(EDGE, Math.min(at.x + 18, area.width - width - EDGE));

  if (area.height <= 0 || at.y + 10 + POPOVER_HEIGHT <= area.height - EDGE)
    return { left, top: Math.max(EDGE, at.y + 10) };

  return { left, bottom: Math.max(EDGE, area.height - (at.y - 30)) };
};

/**
 * How long ago a message was written, as the conversation reads it: `agora`,
 * `há N min`, `há N h`, `há N d`; `''` for a missing or unreadable date.
 */
export const relativeTime = (iso: string | undefined, now = Date.now()) => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);

  if (Number.isNaN(at)) return '';

  const seconds = Math.round((now - at) / 1000);

  if (seconds < 45) return 'agora';

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `há ${String(minutes)} min`;

  const hours = Math.round(minutes / 60);

  return hours < 24
    ? `há ${String(hours)} h`
    : `há ${String(Math.round(hours / 24))} d`;
};

/** One `⋯` menu of the popover: its trigger and its items. */
function MoreMenu({
  label,
  items,
  className,
  testId,
}: {
  readonly label: string;
  readonly items: readonly {
    readonly label: string;
    readonly testId?: string;
    readonly onSelect: () => void;
  }[];
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            data-testid={testId}
            className={className}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuGroup>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              data-testid={item.testId}
              onClick={item.onSelect}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chip the last message wears once the thread awaits the reader or is done. */
function StateChip({ state }: { readonly state: ThreadState }) {
  if (state === 'open') return null;

  return (
    <Badge
      data-testid="papercraft-thread-state"
      variant="outline"
      className={cn(
        'papercraft-state-chip mt-1 h-4.5 justify-self-start border-transparent px-1.5 text-[11px]',
        `papercraft-state-${state}`,
      )}
    >
      {state === 'done' ? '✓ resolvido' : '? aguardando você'}
    </Badge>
  );
}

export interface ThreadPopoverProps {
  /** The content point of the pin's tip. */
  readonly point: ContentPoint;
  readonly viewport: Viewport;
  readonly area: { readonly width: number; readonly height: number };
  readonly pin: number;
  /** Where the pin points, short: `Checkout:42`, `Checkout (412, 180)`. */
  readonly title: string;
  /** The whole anchor, for the title's tooltip and the copy. */
  readonly anchor: string;
  readonly messages: readonly ThreadMessage[];
  /** The sent thread's state; absent while the root is a draft. */
  readonly state?: ThreadState;
  /** Resolves or reopens a sent root; absent while the root is a draft. */
  readonly onResolve?: () => void;
  /** Whether the resolve can be written now (the registry and the prompt). */
  readonly canResolve: boolean;
  /** Whether the resolved threads are shown; the header menu toggles it. */
  readonly showResolved: boolean;
  readonly onToggleShowResolved: () => void;
  /** The reply (or the edit) being written. */
  readonly value: string;
  /** Whether the field edits a draft of the thread rather than replying. */
  readonly editing: boolean;
  readonly onChange: (value: string) => void;
  /** Adds the reply to the stack, or saves the edit. */
  readonly onConfirm: () => void;
  /** Closes without saving (`Esc`). */
  readonly onCancel: () => void;
  /** Closes the thread, keeping what was written (the header's ×). */
  readonly onClose: () => void;
  readonly onEdit: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onCopy: (text: string) => void;
}

/** One message row: the author, when, the text, its menu and its chip. */
function Message({
  message,
  chip,
  onEdit,
  onRemove,
  onCopy,
}: {
  readonly message: ThreadMessage;
  readonly chip: ReactNode;
  readonly onEdit: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onCopy: (text: string) => void;
}) {
  const name = authorName(message.author);

  return (
    <li
      data-testid="papercraft-thread-message"
      data-draft={message.draft ? 'true' : undefined}
      className="group/message grid grid-cols-[1.375rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5"
    >
      <Avatar name={message.author ?? name} className="size-5.5" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-normal">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {message.draft ? 'na pilha' : relativeTime(message.createdAt)}
        </span>
      </span>
      <MoreMenu
        label="Mais ações"
        testId="papercraft-message-more"
        className="size-6 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
        items={[
          { label: 'Copiar texto', onSelect: () => onCopy(message.text) },
          ...(message.draft
            ? [
                {
                  label: 'Editar',
                  testId: 'papercraft-message-edit',
                  onSelect: () => onEdit(message.id),
                },
                {
                  label: 'Remover da pilha',
                  testId: 'papercraft-message-remove',
                  onSelect: () => onRemove(message.id),
                },
              ]
            : []),
        ]}
      />
      <p
        className={cn(
          'col-span-2 col-start-2 whitespace-pre-wrap break-words',
          message.draft && 'text-muted-foreground italic',
        )}
      >
        {message.text}
      </p>
      {chip === null ? null : (
        <span className="col-span-2 col-start-2">{chip}</span>
      )}
    </li>
  );
}

/** The thread of one pin, beside it. */
export function ThreadPopover({
  point,
  viewport,
  area,
  pin,
  title,
  anchor,
  messages,
  state,
  onResolve,
  canResolve,
  showResolved,
  onToggleShowResolved,
  value,
  editing,
  onChange,
  onConfirm,
  onCancel,
  onClose,
  onEdit,
  onRemove,
  onCopy,
}: ThreadPopoverProps) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const placement = popoverPlacement(surfacePoint(point, viewport), area);
  const resolved = state === 'done';
  const root = messages[0];
  const draftRoot = root?.draft === true;
  const lastSent = messages.reduce(
    (last, message, index) => (message.draft ? last : index),
    -1,
  );

  return (
    <div
      ref={setSurface}
      role="dialog"
      aria-label={`Comentário em ${anchor}`}
      data-testid="papercraft-thread"
      className="papercraft-thread pointer-events-auto absolute z-30 flex flex-col rounded-lg border border-border bg-popover text-[12.5px] text-popover-foreground"
      style={{
        left: `${String(placement.left)}px`,
        ...('top' in placement
          ? { top: `${String(placement.top)}px` }
          : { bottom: `${String(placement.bottom)}px` }),
        width: `min(${String(POPOVER_WIDTH)}px, calc(100% - ${String(2 * EDGE)}px))`,
        maxHeight: `calc(100% - ${String(2 * EDGE)}px)`,
      }}
      onKeyDown={(event) => {
        // The thread owns its keys: the canvas's `C`, `Esc` and space never
        // see them; `Esc` anywhere in it closes it without saving — unless a
        // menu of it took that `Esc` to close itself.
        event.stopPropagation();
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <PortalContainerProvider container={surface}>
        <div className="flex items-center gap-0.5 border-b border-border py-1.5 pr-1.5 pl-3">
          <span
            className="mr-auto flex min-w-0 items-center gap-2 text-sm font-normal"
            title={anchor}
          >
            <Badge
              variant="secondary"
              className="h-4.5 min-w-4.5 px-1.5 text-[10.5px] tabular-nums"
            >
              {String(pin)}
            </Badge>
            <span data-testid="papercraft-thread-title" className="truncate">
              {title}
            </span>
          </span>
          <MoreMenu
            label="Mais ações do comentário"
            testId="papercraft-thread-more"
            items={[
              { label: 'Copiar âncora', onSelect: () => onCopy(anchor) },
              ...(draftRoot && root !== undefined
                ? [
                    {
                      label: 'Remover da pilha',
                      testId: 'papercraft-thread-remove',
                      onSelect: () => onRemove(root.id),
                    },
                  ]
                : [
                    {
                      label: showResolved
                        ? 'Esconder resolvidos'
                        : 'Mostrar resolvidos',
                      onSelect: onToggleShowResolved,
                    },
                  ]),
            ]}
          />
          {onResolve === undefined ? null : (
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="papercraft-thread-resolve"
              aria-label={resolved ? 'Reabrir' : 'Resolver'}
              title={resolved ? 'Reabrir' : 'Resolver'}
              aria-pressed={resolved}
              disabled={!canResolve}
              className={cn(resolved && 'papercraft-resolved')}
              onClick={onResolve}
            >
              <CircleCheckIcon aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fechar"
            title="Fechar"
            data-testid="papercraft-thread-close"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        <ol className="flex max-h-60 min-h-0 flex-col gap-3.5 overflow-y-auto py-3 pr-2 pl-3">
          {messages.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              chip={
                index === lastSent && state !== undefined ? (
                  <StateChip state={state} />
                ) : null
              }
              onEdit={(id) => {
                onEdit(id);
                field.current?.focus({ preventScroll: true });
              }}
              onRemove={onRemove}
              onCopy={onCopy}
            />
          ))}
        </ol>
        <CommentField
          className="py-2.5 pr-2.5 pl-3"
          fieldRef={field}
          autoFocus
          value={value}
          action={editing ? 'save' : 'send'}
          placeholder={editing ? 'Editar comentário…' : 'Responder…'}
          confirmTestId="papercraft-thread-confirm"
          leading={
            <Avatar name={authorName(undefined)} className="mb-1 size-5.5" />
          }
          onChange={onChange}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </PortalContainerProvider>
    </div>
  );
}
