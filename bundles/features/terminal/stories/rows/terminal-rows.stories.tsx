import { treeClassName } from 'desktop/ui/panels';
import {
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarScope,
} from 'desktop/ui/sidebar';
import { MessageSquareIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import { TerminalRows } from '../../src/client/rows/terminal-rows.js';
import {
  devServer,
  startingBuild,
  terminals,
  testRun,
  userShell,
} from '../support/fixtures.js';

/** The sidebar tree around the rows: their Thread's row and its subtree. */
const decorators = [
  (Story: ComponentType) => (
    <div
      className="overflow-hidden rounded-md border bg-sidebar py-1 text-sidebar-foreground"
      style={{ width: 288 }}
    >
      <SidebarScope>
        <SidebarMenu className="gap-0">
          <SidebarMenuSubItem className="w-full">
            <div className="flex h-7 items-center gap-2 px-2 text-sm">
              <MessageSquareIcon className="size-4 shrink-0" />
              <span className="truncate">
                Split the payment form into steps
              </span>
            </div>
            <SidebarMenuSub className={treeClassName}>
              <Story />
            </SidebarMenuSub>
          </SidebarMenuSubItem>
        </SidebarMenu>
      </SidebarScope>
    </div>
  ),
];

export default {
  title: 'Terminal/Rows/Terminal rows',
  component: TerminalRows,
  decorators,
};

export const AgentAndUserTerminals = {
  render: () => (
    <TerminalRows
      terminals={terminals}
      depth={1}
      onOpen={() => undefined}
      onStop={() => undefined}
    />
  ),
};

/** A running agent command counts its time against its limit. */
export const RunningWithLimit = {
  render: () => <TerminalRows terminals={[startingBuild]} depth={1} />,
};

export const NoLimit = {
  render: () => <TerminalRows terminals={[devServer]} depth={1} />,
};

export const ExitedCommand = {
  render: () => <TerminalRows terminals={[testRun]} depth={1} />,
};

/** A user's shell shows only its command, and discards instead of stopping. */
export const UserShell = {
  render: () => <TerminalRows terminals={[userShell]} depth={1} />,
};

/** Under a child Thread, one level deeper. */
export const NestedThread = {
  render: () => <TerminalRows terminals={terminals} depth={3} />,
};

export const ManyTerminals = {
  render: () => (
    <TerminalRows
      terminals={Array.from({ length: 12 }, (_, index) => ({
        ...devServer,
        id: `term_worker_${index}`,
        command: `node scripts/seed-orders.mjs --shard ${index + 1}/12`,
        timeoutMs: 60_000,
      }))}
      depth={1}
    />
  ),
};

export const NoTerminals = {
  render: () => <TerminalRows terminals={[]} depth={1} />,
};
