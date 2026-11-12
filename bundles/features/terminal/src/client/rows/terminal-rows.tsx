import { Button } from 'desktop/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import { Input } from 'desktop/ui/input';
import { indentation, TreeGuides } from 'desktop/ui/panels';
import { SidebarMenuSubButton, SidebarMenuSubItem } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import {
  CopyIcon,
  OctagonXIcon,
  PencilIcon,
  SquareIcon,
  TerminalIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { terminalNameLimit } from '../../contracts/index.js';
import { type Terminal, terminalLabel } from '../domain/terminals.js';

/*
 * The terminal rows under one Thread of the sidebar tree (moved from the
 * layout's provisional `terminal-rows.tsx`): a 1 s clock for the elapsed
 * time, a row that opens the terminal and the stop or discard action, and
 * (§4.4) the row's context menu: Rename (A13), Copy command (A14) and Kill
 * terminal (A15).
 */

/**
 * A row's fill, on its item (docs/designs/sidebar-alignment.md §11.1): the
 * selected terminal's row is filled in the accent; another draws the ghost
 * hover fill under the pointer and the ghost pressed fill while pressed.
 */
const rowFill = (selected: boolean): string =>
  selected
    ? 'rounded-[4px] bg-sidebar-accent'
    : 'rounded-[4px] hover:bg-[var(--paper-ghost-hover)] active:bg-[var(--paper-ghost-pressed)]';

/**
 * The row outline: 2 px of --sidebar-ring inset on the item while its button
 * has keyboard focus (§11.3).
 */
const subButtonRing =
  'has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-2 has-[[data-sidebar=menu-sub-button]:focus-visible]:-outline-offset-2 has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-[var(--sidebar-ring)]';

/**
 * The row outline: 2 px of --sidebar-ring inset on the item while its rename
 * field has keyboard-visible focus (§11.3).
 */
const inputRing =
  'has-[[data-slot=input]:focus-visible]:outline-2 has-[[data-slot=input]:focus-visible]:-outline-offset-2 has-[[data-slot=input]:focus-visible]:outline-[var(--sidebar-ring)]';

/**
 * A row button that draws no fill and no ring: its item draws the fill and
 * the outline.
 */
const noFillButton =
  'bg-transparent hover:bg-transparent active:bg-transparent data-active:bg-transparent focus-visible:ring-0';

/** What a refused clipboard write says. */
export const copyCommandFailed = 'Could not copy the command.';

export function TerminalRows({
  terminals,
  depth,
  selectedId,
  onOpen,
  onStop,
  onRename,
  onError,
}: {
  readonly terminals: readonly Terminal[];
  readonly depth: number;
  /** The id of the terminal whose tab is the selected tab. */
  readonly selectedId?: string;
  readonly onOpen?: (terminal: Terminal) => void;
  /** The row's stop or discard button, and Kill terminal in its menu (A15). */
  readonly onStop?: (id: string) => void;
  /**
   * Rename in the row's menu (A13): the trimmed name, or `null` to clear it.
   * The inline name closes when it settles, whatever the answer.
   */
  readonly onRename?: (id: string, name: string | null) => Promise<void>;
  /** Shows a failure the rows cannot recover from (a refused copy). */
  readonly onError?: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [renaming, setRenaming] = useState<string>();
  // Only an agent row shows an elapsed time, so only it needs the clock: the
  // rows of every other Thread stay still instead of rendering each second.
  const timed = terminals.some((terminal) => terminal.origin !== 'user');
  useEffect(() => {
    if (!timed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);
  const copyCommand = (terminal: Terminal) => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(terminal.command))
      .catch(() => onError?.(copyCommandFailed));
  };
  return terminals.map((terminal) => {
    const selected = terminal.id === selectedId;
    return (
      <SidebarMenuSubItem
        key={terminal.id}
        className={cn(
          'group/terminal relative w-full',
          rowFill(selected),
          subButtonRing,
          inputRing,
        )}
      >
        <TreeGuides depth={depth} />
        {renaming === terminal.id && onRename ? (
          <TerminalNameField
            terminal={terminal}
            depth={depth}
            onRename={onRename}
            onClose={() => setRenaming(undefined)}
          />
        ) : (
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <SidebarMenuSubButton
                  size="sm"
                  className={cn(
                    'h-7 w-full translate-x-0 rounded-none pr-8',
                    noFillButton,
                  )}
                  isActive={selected}
                  aria-current={selected ? 'true' : undefined}
                  style={{ paddingLeft: indentation(depth) }}
                  onClick={() => onOpen?.(terminal)}
                  title={terminalLabel(terminal, now)}
                  render={<button type="button" />}
                >
                  <TerminalLead />
                  <span className="truncate">
                    {terminalLabel(terminal, now)}
                  </span>
                </SidebarMenuSubButton>
              }
            />
            <ContextMenuContent>
              {onRename && (
                <>
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => setRenaming(terminal.id)}>
                      <PencilIcon />
                      Rename
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuGroup>
                <ContextMenuItem onClick={() => copyCommand(terminal)}>
                  <CopyIcon />
                  Copy command
                </ContextMenuItem>
              </ContextMenuGroup>
              {onStop && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem
                      variant="destructive"
                      onClick={() => onStop(terminal.id)}
                    >
                      <OctagonXIcon />
                      Kill terminal
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )}
        {renaming !== terminal.id && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-0.5 right-1 opacity-0 group-hover/terminal:opacity-100 group-has-[:focus-visible]/terminal:opacity-100 hover:bg-[var(--paper-ghost-pressed)] dark:hover:bg-[var(--paper-ghost-pressed)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring)] focus-visible:ring-0"
            aria-label={
              terminal.origin === 'user' ? 'Discard terminal' : 'Stop terminal'
            }
            onClick={() => onStop?.(terminal.id)}
          >
            <SquareIcon />
          </Button>
        )}
      </SidebarMenuSubItem>
    );
  });
}

/**
 * A13's inline name: the row's icon and an input holding the current name,
 * at most 80 characters. Enter sends the trimmed text (`null` when it is
 * empty, which clears the name); Escape and blur close it unsent. While the
 * call runs the input is read-only; whatever it answers, the field closes,
 * so a failed call leaves the old name.
 */
function TerminalNameField({
  terminal,
  depth,
  onRename,
  onClose,
}: {
  readonly terminal: Terminal;
  readonly depth: number;
  readonly onRename: (id: string, name: string | null) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(terminal.name ?? '');
  const [pending, setPending] = useState(false);
  const submit = () => {
    if (pending) return;
    const name = value.trim();
    setPending(true);
    void onRename(terminal.id, name === '' ? null : name)
      .catch(() => undefined)
      .finally(onClose);
  };
  return (
    <div
      className="flex h-7 w-full items-center gap-2 pr-1 [&>svg]:size-4 [&>svg]:shrink-0"
      style={{ paddingLeft: indentation(depth) }}
    >
      <TerminalLead />
      <Input
        aria-label="Terminal name"
        className="h-6 px-1.5 py-0 text-sm focus-visible:ring-0"
        maxLength={terminalNameLimit}
        placeholder={terminal.command}
        value={value}
        readOnly={pending}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => {
          if (!pending) onClose();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!pending) onClose();
          }
        }}
      />
    </div>
  );
}

/**
 * A terminal row's lead: the terminal icon in the same 16 px slot, at the same
 * 14 px, as the Thread and file rows' leads, so the names line up.
 */
function TerminalLead() {
  return (
    <span
      aria-hidden
      data-slot="terminal-lead"
      className="flex size-4 shrink-0 items-center justify-center text-sidebar-accent-foreground [&_svg]:size-3.5!"
    >
      <TerminalIcon />
    </span>
  );
}
