// `command-toolbar.tsx` — the window's command bar (spec: "A barra de
// comandos").
//
// An overlay, like the header: floating over the canvas, centred on the bottom
// edge, with a margin, rounded corners, a border, a translucent blurred
// background and a shadow — the canvas keeps scrolling behind it and there is
// still no footer. It is built from the registry's components
// (`desktop/ui/<component>`), not from hand-rolled CSS: `ToggleGroup`/`Toggle`
// for the armed tool, ghost icon buttons for the rest, `Tooltip` with a
// `<kbd>` in its content for the label and the shortcut, `Badge` for the pin
// count, a `Separator` shorter than the bar between the groups (the
// `ToolbarDivider` drawing the chat composer uses is chat's; this is the same
// recipe over the registry), and `lucide` icons.
//
// Four groups, three dividers, left to right: the armed tool, what the
// selection does, the viewport, and the proposal. Every control dispatches by
// `commands/v1.execute` — the path the `git` Changes panel uses — and reads a
// field of the frame's state, never a new one of its own. What is unavailable
// is disabled, not hidden: the two exceptions are the readings — the revision
// exists only with more than one, and `Autorizar` becomes the reading
// `Autorizado` once the revision on screen is approved.

import type { Commands } from 'bundle/contracts';
import { Badge } from 'desktop/ui/badge';
import { Button } from 'desktop/ui/button';
import {
  CanvasToolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarTooltip,
} from 'desktop/ui/canvas';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from 'desktop/ui/toggle-group';
import { cn } from 'desktop/ui/utils';
import {
  CheckIcon,
  EyeIcon,
  FocusIcon,
  HandIcon,
  MaximizeIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';

import {
  APPROVE_COMMAND,
  COMMENT_COMMAND,
  ISOLATE_COMMAND,
  PAN_COMMAND,
  type PreviewTool,
  type RevisionReading,
  SELECT_COMMAND,
  SELECT_REVISION_COMMAND,
  SHOW_ALL_COMMAND,
  ZOOM_FIT_COMMAND,
  ZOOM_IN_COMMAND,
  ZOOM_OUT_COMMAND,
  ZOOM_RESET_COMMAND,
} from '../../contracts/index.js';

/** The one input every command of the bar takes: which canvas it acts on. */
export type Execute = (
  command: Parameters<Commands['execute']>[0],
  input?: unknown,
) => void;

/** What one command control is: a ghost icon button with a tooltip. */
function CommandButton({
  label,
  command,
  shortcut,
  disabled,
  execute,
  artifactId,
  children,
}: {
  readonly label: string;
  readonly command: Parameters<Commands['execute']>[0];
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly execute: Execute;
  readonly artifactId: string;
  readonly children: ReactNode;
}) {
  return (
    <ToolbarButton
      label={label}
      {...(shortcut === undefined ? {} : { shortcut })}
      data-command={command}
      disabled={disabled === true}
      onClick={() => execute(command, { artifactId })}
    >
      {children}
    </ToolbarButton>
  );
}

export interface CommandToolbarProps {
  readonly artifactId: string;
  readonly execute: Execute;
  /** The armed tool: a radio group, only one at a time. */
  readonly tool: PreviewTool;
  /** How many pending comment pins the revision carries. */
  readonly pinCount: number;
  /** `Isolar` is enabled once a node is selected. */
  readonly hasSelection: boolean;
  /** `Mostrar tudo` is enabled once something is hidden or isolated. */
  readonly hasHidden: boolean;
  /** The viewport's zoom reading, as the middle control shows it. */
  readonly zoom: string;
  /** The proposal: which revisions exist and which is on screen. */
  readonly revisions: RevisionReading;
  /** Under the `request` policy only, and only while not yet approved. */
  readonly approvalNeeded: boolean;
}

/**
 * The four groups and the three dividers of the window's command bar.
 * Memoised: a pan of the canvas changes none of its readings, so its
 * tooltips, toggle group and menu are not drawn again for one.
 */
export const CommandToolbar = memo(function CommandToolbar({
  artifactId,
  execute,
  tool,
  pinCount,
  hasSelection,
  hasHidden,
  zoom,
  revisions,
  approvalNeeded,
}: CommandToolbarProps) {
  return (
    <CanvasToolbar
      label="comandos do canvas"
      data-tool={tool}
      className="papercraft-command-bar absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
    >
      {/* Ferramenta: a radio group, one tool armed at a time. */}
      <ToggleGroup
        value={[tool]}
        onValueChange={(values) => {
          // Pressing the armed tool again leaves nothing armed: ignore it.
          const next = values[0];
          if (next === undefined) return;
          execute(
            next === 'select'
              ? SELECT_COMMAND
              : next === 'comment'
                ? COMMENT_COMMAND
                : PAN_COMMAND,
            { artifactId },
          );
        }}
      >
        <ToolbarTooltip label="Selecionar" shortcut="V">
          <ToggleGroupItem
            value="select"
            aria-label="Selecionar"
            data-command={SELECT_COMMAND}
          >
            <MousePointer2Icon aria-hidden="true" />
          </ToggleGroupItem>
        </ToolbarTooltip>
        <ToolbarTooltip label="Comentar" shortcut="C">
          <ToggleGroupItem
            value="comment"
            aria-label="Comentar"
            data-command={COMMENT_COMMAND}
            className="relative"
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            {pinCount === 0 ? null : (
              <Badge
                variant="secondary"
                data-testid="papercraft-pin-count"
                className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-0.5 text-[9px]"
              >
                {String(pinCount)}
              </Badge>
            )}
          </ToggleGroupItem>
        </ToolbarTooltip>
        <ToolbarTooltip label="Mão" shortcut="H">
          <ToggleGroupItem
            value="pan"
            aria-label="Mão"
            data-command={PAN_COMMAND}
          >
            <HandIcon aria-hidden="true" />
          </ToggleGroupItem>
        </ToolbarTooltip>
      </ToggleGroup>

      <ToolbarSeparator />

      {/* Seleção */}
      <ToolbarGroup label="Seleção">
        <CommandButton
          label="Isolar"
          command={ISOLATE_COMMAND}
          shortcut="I"
          disabled={!hasSelection}
          execute={execute}
          artifactId={artifactId}
        >
          <FocusIcon aria-hidden="true" />
        </CommandButton>
        <CommandButton
          label="Mostrar tudo"
          command={SHOW_ALL_COMMAND}
          shortcut="Shift+I"
          disabled={!hasHidden}
          execute={execute}
          artifactId={artifactId}
        >
          <EyeIcon aria-hidden="true" />
        </CommandButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Viewport */}
      <ToolbarGroup label="Viewport">
        <CommandButton
          label="Menos zoom"
          command={ZOOM_OUT_COMMAND}
          shortcut="CmdOrCtrl+-"
          execute={execute}
          artifactId={artifactId}
        >
          <ZoomOutIcon aria-hidden="true" />
        </CommandButton>
        <ToolbarButton
          label="Zoom 100%"
          shortcut="CmdOrCtrl+0"
          size="sm"
          data-command={ZOOM_RESET_COMMAND}
          className={cn('min-w-12 px-1.5 font-mono text-xs tabular-nums')}
          onClick={() => execute(ZOOM_RESET_COMMAND, { artifactId })}
        >
          {zoom}
        </ToolbarButton>
        <CommandButton
          label="Mais zoom"
          command={ZOOM_IN_COMMAND}
          shortcut="CmdOrCtrl+="
          execute={execute}
          artifactId={artifactId}
        >
          <ZoomInIcon aria-hidden="true" />
        </CommandButton>
        <CommandButton
          label="Ajustar"
          command={ZOOM_FIT_COMMAND}
          shortcut="Shift+1"
          execute={execute}
          artifactId={artifactId}
        >
          <MaximizeIcon aria-hidden="true" />
        </CommandButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Proposta: the revision reading, and `Autorizar` under `request`. */}
      <ToolbarGroup label="Proposta">
        {revisions.total > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Revisão"
                  className={cn('min-w-16 font-mono text-xs tabular-nums')}
                />
              }
            >
              rev {String(revisions.current)}/{String(revisions.total)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {revisions.list.map((revision) => (
                <DropdownMenuItem
                  key={revision}
                  onClick={() =>
                    execute(SELECT_REVISION_COMMAND, {
                      artifactId,
                      revision,
                    })
                  }
                >
                  rev {String(revision)}
                  {revision === revisions.current ? (
                    <CheckIcon aria-hidden="true" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="px-2 font-mono text-xs text-muted-foreground tabular-nums">
            rev {String(revisions.current)}/{String(revisions.total)}
          </span>
        )}

        {approvalNeeded ? (
          <Button
            size="sm"
            variant="default"
            aria-label="Autorizar"
            onClick={() => execute(APPROVE_COMMAND, { artifactId })}
          >
            <CheckIcon aria-hidden="true" />
            Autorizar
          </Button>
        ) : revisions.approved ? (
          <span
            className="px-2 text-xs text-muted-foreground"
            data-approved="true"
          >
            Autorizado
          </span>
        ) : null}
      </ToolbarGroup>
    </CanvasToolbar>
  );
});
