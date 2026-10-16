// `preview-header.tsx` — the header overlaid on the canvas, the same in the
// node and in the window (spec: "A UI no node e na janela").
//
// The canvas fills the whole frame and flows under this header: a transparent
// band with the title and the muted revision on the left and icon
// buttons on the right — `abrir` (the node only) and the comment tool, pressed
// while comment mode is on, with the count of what is pending and drafted, and,
// once a thread of the revision is resolved, the eye that shows or hides the
// resolved pins. In
// the window a band carries the macOS traffic lights' safe area, and a send
// button (`Enviar ao agente (n)`) shows while there are drafts, because the
// window has no prompt of its own to send them with. The node shows the buttons
// only while it is focused; the title and the revision always.

import { Badge } from 'desktop/ui/badge';
import { Button } from 'desktop/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import {
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  MessageSquarePlusIcon,
  SendIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export interface PreviewHeaderProps {
  readonly chrome: 'node' | 'canvas';
  readonly title: string;
  /** Whether the buttons show: the node shows them only while focused. */
  readonly controls?: boolean;
  readonly revision?: number;
  readonly canOpen: boolean;
  readonly onOpen: () => void;
  readonly commentActive: boolean;
  readonly canComment: boolean;
  /** What the comment control counts: unresolved threads plus draft pins. */
  readonly commentCount: number;
  /**
   * The show/hide control of the resolved pins, offered while a thread of the
   * revision is resolved.
   */
  readonly resolvedToggle?: {
    readonly shown: boolean;
    readonly onToggle: () => void;
  };
  readonly onToggleComment: () => void;
  /** The drafts of this preview the window's send button sends. */
  readonly draftCount: number;
  readonly onSend: () => void;
}

/** One icon button with its tooltip. */
function IconButton({
  label,
  shortcut,
  children,
  ...props
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly children: ReactNode;
} & Omit<Parameters<typeof Button>[0], 'children'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="relative [-webkit-app-region:no-drag]"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        {shortcut === undefined ? null : (
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The overlay header of one preview frame. */
export function PreviewHeader({
  chrome,
  title,
  controls = true,
  revision,
  canOpen,
  onOpen,
  commentActive,
  canComment,
  commentCount,
  onToggleComment,
  resolvedToggle,
  draftCount,
  onSend,
}: PreviewHeaderProps) {
  return (
    <div
      data-testid="papercraft-header"
      className={cn(
        'papercraft-header absolute inset-x-0 top-0 z-30 flex items-center gap-2 bg-transparent px-2',
        chrome === 'node' && 'h-9',
        chrome === 'canvas' &&
          'h-(--doric-titlebar-height) ps-[calc(var(--doric-safe-left)+0.5rem)] [-webkit-app-region:drag]',
      )}
    >
      <span className="min-w-0 truncate text-sm">{title}</span>
      {revision === undefined ? null : (
        <span
          data-testid="papercraft-revision"
          className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
        >
          rev {String(revision)}
        </span>
      )}
      {controls ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {chrome === 'canvas' && draftCount > 0 ? (
            <Button
              size="sm"
              data-testid="papercraft-send"
              className="h-7 gap-1 [-webkit-app-region:no-drag]"
              onClick={onSend}
            >
              <SendIcon aria-hidden="true" />
              Enviar ao agente ({String(draftCount)})
            </Button>
          ) : null}
          {chrome === 'node' ? (
            <IconButton
              label="Abrir"
              data-testid="papercraft-open"
              disabled={!canOpen}
              onClick={onOpen}
            >
              <ExternalLinkIcon aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            label="Comentar"
            shortcut="C"
            data-testid="papercraft-comment"
            aria-pressed={commentActive}
            disabled={!canComment}
            className={cn(
              'relative [-webkit-app-region:no-drag]',
              commentActive && 'bg-primary/15 text-primary',
            )}
            onClick={onToggleComment}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            {commentCount === 0 ? null : (
              <Badge
                data-testid="papercraft-comment-count"
                className="pointer-events-none absolute -top-1 -right-1 h-3.5 min-w-3.5 px-0.5 text-[9px] leading-none"
              >
                {String(commentCount)}
              </Badge>
            )}
          </IconButton>
          {resolvedToggle === undefined ? null : (
            <IconButton
              label={
                resolvedToggle.shown
                  ? 'Esconder resolvidos'
                  : 'Mostrar resolvidos'
              }
              data-testid="papercraft-show-resolved"
              aria-pressed={resolvedToggle.shown}
              onClick={resolvedToggle.onToggle}
            >
              {resolvedToggle.shown ? (
                <EyeIcon aria-hidden="true" />
              ) : (
                <EyeOffIcon aria-hidden="true" />
              )}
            </IconButton>
          )}
        </span>
      ) : null}
    </div>
  );
}
