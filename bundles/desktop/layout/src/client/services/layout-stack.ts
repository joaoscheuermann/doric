// layout.stack/v2 (2.0.0): the sidebar's vertical stack — the panes bundles
// register, their order, and which of them is expanded. The layout draws one
// group per pane under the Thread region — its header and, while open, its
// content — so the frame stays blind to what a pane shows: `screen`'s views
// today, whatever else a composition adds.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutStackV2,
  layoutStackMethods,
  type StackPane,
} from '../../contracts/index.js';
import {
  isPaneOpen,
  registerPane,
  setPaneOpen,
  stackStore,
  togglePane,
} from '../stores/stack.js';
import { watchAll } from './subscription.js';

export const createLayoutStack = () =>
  defineService(LayoutStackV2, {
    register: defineMethod({
      ...layoutStackMethods.register,
      execute: (pane: StackPane) => registerPane(pane),
    }),
    panes: defineMethod({
      ...layoutStackMethods.panes,
      execute: () => stackStore.getState().panes,
    }),
    isOpen: defineMethod({
      ...layoutStackMethods.isOpen,
      execute: (paneId: string) => isPaneOpen(paneId),
    }),
    setOpen: defineMethod({
      ...layoutStackMethods.setOpen,
      execute: ([paneId, open]: [string, boolean]) => setPaneOpen(paneId, open),
    }),
    toggle: defineMethod({
      ...layoutStackMethods.toggle,
      execute: (paneId: string) => togglePane(paneId),
    }),
    subscribe: defineMethod({
      ...layoutStackMethods.subscribe,
      execute: (listener: () => void) =>
        watchAll(listener, [(notify) => stackStore.subscribe(notify)]),
    }),
  });
