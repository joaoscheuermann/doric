// The layout's client part (stage 9, §5.3; bundle isolation 4(c)): the
// workspace window's frame and its slots, and the layout contracts. The
// navigation that fills the slots is `workspace`'s; the files, git, terminal,
// usage and resources bundles draw their own region items. All of it is bound
// to the activation services, never to an element's (D9-17).

import {
  type Cleanup,
  type ClientContext,
  NavigationV1,
  UiV1,
} from 'bundle/contracts';

import { LayoutWorkspaceElement } from './elements/workspace-element.js';
import { createLayoutConversation } from './services/layout-conversation.js';
import { createLayoutPanelV3 } from './services/layout-panel.js';
import { setLayoutServices } from './services/layout-services.js';
import { createLayoutStack } from './services/layout-stack.js';
import { createLayoutTabs } from './services/layout-tabs.js';
import { resetBottom } from './stores/bottom.js';
import { resetPanel } from './stores/panel.js';
import { resetStack } from './stores/stack.js';

export function activate({ services }: ClientContext): Cleanup {
  setLayoutServices(services);

  const ui = services.use(UiV1);
  ui.define('layout-workspace', LayoutWorkspaceElement);

  services.use(NavigationV1).register({
    path: '/',
    create: () => ui.create('layout-workspace'),
  });
  services.provide(createLayoutTabs({ ui }));
  // The Project panel, the conversation's bottom split and the sidebar's
  // stack, which carries the groups bundles register under the sidebar's
  // Thread region (the Screens and MCP panes today).
  services.provide(createLayoutPanelV3());
  services.provide(createLayoutConversation());
  services.provide(createLayoutStack());

  return () => {
    resetPanel();
    resetBottom();
    resetStack();
    setLayoutServices(undefined);
  };
}
