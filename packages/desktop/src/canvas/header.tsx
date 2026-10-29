// `header.tsx` — the header overlaid on a canvas, the same in the
// node and in its modal (spec: "A UI no node e na janela").
//
// The canvas fills the whole frame and flows under this header: a transparent
// band with the title and the muted revision on the left and icon
// buttons on the right — `expandir` (the node only) and the comment tool, pressed
// while comment mode is on, with the count of what is pending and drafted, and,
// once a thread of the revision is resolved, the eye that shows or hides the
// resolved pins. In
// the node's modal a send button (`Enviar ao agente (n)`) shows while there
// are drafts, because it has no prompt of its own to send them with. The node shows the buttons
// only while it is focused; the title and the revision always.

import {
  EyeIcon,
  EyeOffIcon,
  Maximize2Icon,
  MessageSquarePlusIcon,
  SendIcon,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/tooltip.js';
import { cn } from '../lib/utils.js';

export interface CanvasHeaderProps {
  /**
   * Where the header is mounted: the conversation node (a 36px band) or the
   * node's modal (a 36px band with the send button while there are drafts,
   * leaving room for the modal's close button).
   */
  readonly host: 'node' | 'modal';
  readonly title: string;
  /** Whether the buttons show: the node shows them only while focused. Default true. */
  readonly controls?: boolean;
  readonly revision?: number;
  /** `expandir` (node only): whether it is enabled, and what it does. */
  readonly canExpand: boolean;
  readonly onExpand: () => void;
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
  /** The drafts the send button of the modal sends. */
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
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="relative [-webkit-app-region:no-drag]"
            {...props}
          />
        }
      >
        {children}
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

/**
 * The header overlaid on a canvas: title and `rev N` (`papercraft-revision`)
 * on the left; `Enviar ao agente (n)` (`papercraft-send`, modal only,
 * while `draftCount > 0`), `Expandir` (`papercraft-expand`, node only), `Comentar`
 * (`papercraft-comment`, shortcut `C`, `aria-pressed`, with
 * `papercraft-comment-count`) and the resolved eye (`papercraft-show-resolved`)
 * on the right. Root `data-testid="papercraft-header"`. Memoised: stable
 * actions keep a pan from re-rendering it.
 */
export const CanvasHeader = memo(function CanvasHeader({
  host,
  title,
  controls = true,
  revision,
  canExpand,
  onExpand,
  commentActive,
  canComment,
  commentCount,
  onToggleComment,
  resolvedToggle,
  draftCount,
  onSend,
}: CanvasHeaderProps) {
  return (
    <div
      data-testid="papercraft-header"
      className={cn(
        'papercraft-header absolute inset-x-0 top-0 z-30 flex items-center gap-2 bg-transparent px-2',
        host === 'node' && 'h-9',
        host === 'modal' && 'h-9 pe-11',
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
          {host !== 'node' && draftCount > 0 ? (
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
          {host === 'node' ? (
            <IconButton
              label="Expandir"
              data-testid="papercraft-expand"
              disabled={!canExpand}
              onClick={onExpand}
            >
              <Maximize2Icon aria-hidden="true" />
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
});
