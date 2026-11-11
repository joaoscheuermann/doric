// The terminal bundle's rows as a story mounts them: the same sidebar row the
// real `<terminal-rows>` draws — a terminal icon, the command, and the stop or
// discard button that appears on hover — over fixture rows instead of the
// bundle's store. The element stand-ins say where another bundle's UI lands;
// this one says it with the styling the app draws.

import { Button } from 'desktop/ui/button';
import { indentation, TreeGuides } from 'desktop/ui/panels';
import { SidebarMenuSubButton, SidebarMenuSubItem } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { SquareIcon, TerminalIcon } from 'lucide-react';

import { noFillButton, rowFill } from '../../src/client/domain/sidebar.js';

/** One fixture terminal: an open one, or an agent's run and its elapsed time. */
export interface FixtureTerminal {
  readonly id: string;
  readonly label: string;
  readonly origin: 'user' | 'agent';
}

/** The rows under one Thread, as `<terminal-rows thread-id>` paints them. */
export function TerminalRowsFixture({
  depth,
  terminals,
}: {
  readonly depth: number;
  readonly terminals: readonly FixtureTerminal[];
}) {
  return terminals.map((terminal) => (
    <SidebarMenuSubItem
      key={terminal.id}
      className={cn(
        'group/terminal relative w-full',
        rowFill(false),
        'has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-2 has-[[data-sidebar=menu-sub-button]:focus-visible]:-outline-offset-2 has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-[var(--sidebar-ring)]',
      )}
    >
      <TreeGuides depth={depth} />
      <SidebarMenuSubButton
        size="sm"
        className={cn(
          'h-7 w-full translate-x-0 rounded-none pr-8',
          noFillButton,
        )}
        style={{ paddingLeft: indentation(depth) }}
        title={terminal.label}
        render={<button type="button" />}
      >
        <span
          aria-hidden
          data-slot="terminal-lead"
          className="flex size-4 shrink-0 items-center justify-center text-sidebar-accent-foreground [&_svg]:size-3.5!"
        >
          <TerminalIcon
            className={cn(
              terminal.origin === 'agent' && 'text-muted-foreground',
            )}
          />
        </span>
        <span className="truncate">{terminal.label}</span>
      </SidebarMenuSubButton>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-0.5 right-1 opacity-0 group-hover/terminal:opacity-100 group-has-[:focus-visible]/terminal:opacity-100 hover:bg-[var(--paper-ghost-pressed)] dark:hover:bg-[var(--paper-ghost-pressed)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring)] focus-visible:ring-0"
        aria-label={
          terminal.origin === 'user' ? 'Discard terminal' : 'Stop terminal'
        }
      >
        <SquareIcon />
      </Button>
    </SidebarMenuSubItem>
  ));
}
