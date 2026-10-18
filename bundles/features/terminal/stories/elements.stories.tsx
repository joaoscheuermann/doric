import { treeClassName } from 'desktop/ui/panels';
import {
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarScope,
} from 'desktop/ui/sidebar';
import { useState } from 'react';

import { defineTerminalElements } from '../src/client/elements.js';
import { ElementHost } from './support/element-host.js';
import { devServer, threadId } from './support/fixtures.js';
import { still, storyServices } from './support/services.js';
import {
  storyTerminalApi,
  storyTerminalStore,
  storyWatches,
} from './support/terminal-client.js';

/**
 * The three elements the terminal client defines, over one seeded
 * activation: the fixture terminals, their output, and the layout's
 * workspace with the payment form Thread selected (or nothing selected).
 */
const useElements = (selected: boolean) =>
  useState(() => {
    const elements = defineTerminalElements({
      api: storyTerminalApi(),
      watches: storyWatches(),
      store: storyTerminalStore(),
      open: () => undefined,
    });
    const record = { id: threadId, projectId: 'prj_checkout' };
    const services = storyServices({
      apis: {
        'layout.workspace/v1': {
          ...still,
          thread: (id: string) => (id === threadId ? record : undefined),
          selectedThread: () => (selected ? record : undefined),
        },
      },
    });
    return { elements, services };
  })[0];

const rowsProperties = { 'thread-id': threadId };

const viewProperties = { terminalId: devServer.id, showHeader: true };

export default {
  title: 'Terminal/Elements/Terminal elements',
};

export const View = {
  render: function View() {
    const { elements, services } = useElements(true);
    return (
      <div
        className="overflow-hidden rounded-md border"
        style={{ height: 380 }}
      >
        <ElementHost
          tag="story-terminal-view"
          element={elements.view}
          services={services}
          properties={viewProperties}
        />
      </div>
    );
  },
};

export const Rows = {
  render: function Rows() {
    const { elements, services } = useElements(true);
    return (
      <div
        className="overflow-hidden rounded-md border bg-sidebar py-1 text-sidebar-foreground"
        style={{ width: 288 }}
      >
        <SidebarScope>
          <SidebarMenu className="gap-0">
            <SidebarMenuSubItem className="w-full">
              <div className="flex h-7 items-center px-2 text-sm">
                Split the payment form into steps
              </div>
              <SidebarMenuSub className={treeClassName}>
                <ElementHost
                  tag="story-terminal-rows"
                  element={elements.rows}
                  services={services}
                  properties={rowsProperties}
                />
              </SidebarMenuSub>
            </SidebarMenuSubItem>
          </SidebarMenu>
        </SidebarScope>
      </div>
    );
  },
};

export const NewTerminalButton = {
  render: function NewTerminalButton() {
    const { elements, services } = useElements(true);
    return (
      <div className="flex chrome-bar w-72 items-center justify-end rounded-md border bg-sidebar">
        <ElementHost
          tag="story-terminal-new-button"
          element={elements.newButton}
          services={services}
        />
      </div>
    );
  },
};

/** With no Thread selected there is nowhere to open a shell. */
export const NewTerminalButtonDisabled = {
  render: function NewTerminalButtonDisabled() {
    const { elements, services } = useElements(false);
    return (
      <div className="flex chrome-bar w-72 items-center justify-end rounded-md border bg-sidebar">
        <ElementHost
          tag="story-terminal-new-button-off"
          element={elements.newButton}
          services={services}
        />
      </div>
    );
  },
};
