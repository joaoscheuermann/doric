import { SidebarMenu, SidebarMenuItem, SidebarScope } from 'desktop/ui/sidebar';
import type { ComponentType, ReactNode } from 'react';

import { RowAddAction } from '../../../src/client/components/molecules/row-add-action.js';
import { minutesAgo } from '../../support/data.js';

const ignore = () => undefined;

function TreeRow({
  children,
  name,
}: {
  readonly children: ReactNode;
  readonly name: string;
}) {
  return (
    <SidebarMenuItem>
      <div className="group/tree-row relative flex h-7 w-full items-center pr-16 pl-3 text-xs">
        {name}
        {children}
      </div>
    </SidebarMenuItem>
  );
}

export default {
  title: 'Layout/Molecules/Row add action',
  component: RowAddAction,
  decorators: [
    (Story: ComponentType) => (
      <SidebarScope>
        <div className="w-60 bg-sidebar py-1 text-sidebar-foreground">
          <SidebarMenu className="gap-0">
            <Story />
          </SidebarMenu>
        </div>
      </SidebarScope>
    ),
  ],
};

/** Idle: the plus appears on hover or focus of the row. */
export const Idle = {
  render: () => (
    <TreeRow name="Plan the checkout flow">
      <RowAddAction
        label="New child thread in Plan the checkout flow"
        onAdd={ignore}
      />
    </TreeRow>
  ),
};

/** An agent running for two minutes: the elapsed badge, hidden on hover. */
export const Running = {
  render: () => (
    <TreeRow name="Build the payment form">
      <RowAddAction
        label="New child thread in Build the payment form"
        onAdd={ignore}
        startedAt={minutesAgo(2)}
      />
    </TreeRow>
  ),
};

/** A run past the hour. */
export const LongRun = {
  render: () => (
    <TreeRow name="Accessibility audit">
      <RowAddAction
        label="New child thread in Accessibility audit"
        onAdd={ignore}
        startedAt={minutesAgo(75)}
      />
    </TreeRow>
  ),
};
