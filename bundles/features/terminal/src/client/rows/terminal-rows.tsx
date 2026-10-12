import { Button } from 'desktop/ui/button';
import { indentation, TreeGuides } from 'desktop/ui/panels';
import { SidebarMenuSubButton, SidebarMenuSubItem } from 'desktop/ui/sidebar';
import { SquareIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { type Terminal, terminalLabel } from '../domain/terminals.js';

/*
 * The terminal rows under one Thread of the sidebar tree (moved from the
 * layout's provisional `terminal-rows.tsx`): a 1 s clock for the elapsed
 * time, a row that opens the terminal and the stop or discard action.
 */

export function TerminalRows({
  terminals,
  depth,
  onOpen,
  onStop,
}: {
  readonly terminals: readonly Terminal[];
  readonly depth: number;
  readonly onOpen?: (terminal: Terminal) => void;
  readonly onStop?: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return terminals.map((terminal) => (
    <SidebarMenuSubItem
      key={terminal.id}
      className="group/terminal relative w-full"
    >
      <TreeGuides depth={depth} />
      <SidebarMenuSubButton
        asChild
        size="sm"
        className="h-7 w-full translate-x-0 rounded-none pr-8"
        style={{ paddingLeft: indentation(depth) }}
        onClick={() => onOpen?.(terminal)}
        title={terminalLabel(terminal, now)}
      >
        <button type="button">
          <TerminalIcon />
          <span className="truncate">{terminalLabel(terminal, now)}</span>
        </button>
      </SidebarMenuSubButton>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-0.5 right-1 opacity-0 group-hover/terminal:opacity-100 group-focus-within/terminal:opacity-100"
        aria-label={
          terminal.origin === 'user' ? 'Discard terminal' : 'Stop terminal'
        }
        onClick={() => onStop?.(terminal.id)}
      >
        <SquareIcon />
      </Button>
    </SidebarMenuSubItem>
  ));
}
