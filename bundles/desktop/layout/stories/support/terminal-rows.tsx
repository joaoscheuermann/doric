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
      className="group/terminal relative w-full"
    >
      <TreeGuides depth={depth} />
      <SidebarMenuSubButton
        size="sm"
        className="h-7 w-full translate-x-0 rounded-none pr-8"
        style={{ paddingLeft: indentation(depth) }}
        title={terminal.label}
        render={<button type="button" />}
      >
        <TerminalIcon
          className={cn(terminal.origin === 'agent' && 'text-muted-foreground')}
        />
        <span className="truncate">{terminal.label}</span>
      </SidebarMenuSubButton>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-0.5 right-1 opacity-0 group-hover/terminal:opacity-100 group-focus-within/terminal:opacity-100"
        aria-label={
          terminal.origin === 'user' ? 'Discard terminal' : 'Stop terminal'
        }
      >
        <SquareIcon />
      </Button>
    </SidebarMenuSubItem>
  ));
}
