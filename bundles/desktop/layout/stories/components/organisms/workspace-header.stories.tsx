import { SidebarProvider } from 'desktop/ui/sidebar';
import type { ComponentType } from 'react';

import {
  WorkspaceHeader,
  WorkspaceSidebarHeader,
} from '../../../src/client/components/organisms/workspace-header.js';
import {
  checkout,
  checkoutThreads,
  docs,
  validationThread,
} from '../../support/data.js';
import { Placeholder } from '../../support/placeholder.js';
import { pathTo } from '../../support/workspace.js';

const ignore = () => undefined;

const sidebar = (open: boolean) => (Story: ComponentType) => (
  <SidebarProvider defaultOpen={open} className="min-h-0 flex-col">
    <div className="w-[960px] max-w-full">
      <Story />
    </div>
  </SidebarProvider>
);

export default {
  title: 'Layout/Organisms/Workspace header',
  component: WorkspaceHeader,
  decorators: [sidebar(true)],
};

/** A child Thread's path, with the header items other bundles add. */
export const ThreadPath = {
  render: () => (
    <WorkspaceHeader
      project={checkout}
      path={pathTo(checkoutThreads, validationThread)}
      onSelectProject={ignore}
      onSelectThread={ignore}
      actions={
        <div className="flex items-center gap-2 pr-2">
          <Placeholder tag="terminal-new-button" />
        </div>
      }
    />
  ),
};

/** A Project with no Thread selected. */
export const ProjectOnly = {
  render: () => (
    <WorkspaceHeader
      project={docs}
      path={[]}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** The sidebar closed: its toggle moves into this header. */
export const SidebarClosed = {
  decorators: [sidebar(false)],
  render: () => (
    <WorkspaceHeader
      project={checkout}
      path={pathTo(checkoutThreads, validationThread)}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** The sidebar's own header: the toggle that hides it. */
export const SidebarHeader = {
  render: () => (
    <div className="w-60">
      <WorkspaceSidebarHeader />
    </div>
  ),
};
