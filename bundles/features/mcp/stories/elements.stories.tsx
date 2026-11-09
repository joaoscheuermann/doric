import type { ComponentType } from 'react';

import { defineMcpElements } from '../src/client/elements.js';
import {
  everyStatus,
  filesServer,
  linearServer,
  projectId,
} from './support/fixtures.js';
import { McpPane } from './support/pane.js';

export default {
  title: 'MCP/Elements/MCP pane',
  component: defineMcpElements,
  // The pane at the sidebar's width, on the window's `--sidebar` canvas, where
  // the layout draws it: the sidebar has no card and no edge of its own
  // (ui-redesign S34).
  decorators: [
    (Story: ComponentType) => (
      <div className="w-64 bg-sidebar py-1 text-sidebar-foreground">
        <Story />
      </div>
    ),
  ],
};

/** The selected Project's servers: a connected http one and an idle stdio one. */
export const Servers = {
  render: () => (
    <McpPane setup={{ projectId, servers: [linearServer, filesServer] }} />
  ),
};

/** Every status a row reads; the one asking to sign in offers it. */
export const EveryStatus = {
  render: () => <McpPane setup={{ projectId, servers: everyStatus }} />,
};

/** A Project without servers: the header's add control. */
export const Empty = {
  render: () => <McpPane setup={{ projectId, servers: [] }} />,
};

/** No Project selected: nothing to list, and the add control is disabled. */
export const NoSelection = {
  render: () => <McpPane setup={{ servers: [] }} />,
};
