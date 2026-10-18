// layout.panel/v1 (WP-10P, R-9.2): the Project panel's open state and
// selected view, backed by the panel store the workspace view draws.

import { defineMethod, defineService } from 'bundle/contracts';

import { LayoutPanelV1, layoutPanelMethods } from '../../contracts/index.js';
import { panelStore } from '../stores/panel.js';
import { watchAll } from './subscription.js';

export const createLayoutPanel = () =>
  defineService(LayoutPanelV1, {
    isOpen: defineMethod({
      ...layoutPanelMethods.isOpen,
      execute: () => panelStore.getState().open,
    }),
    active: defineMethod({
      ...layoutPanelMethods.active,
      execute: () => panelStore.getState().active,
    }),
    show: defineMethod({
      ...layoutPanelMethods.show,
      execute: (id: string) => panelStore.getState().show(id),
    }),
    toggle: defineMethod({
      ...layoutPanelMethods.toggle,
      execute: () => panelStore.getState().toggle(),
    }),
    subscribe: defineMethod({
      ...layoutPanelMethods.subscribe,
      execute: (listener: () => void) =>
        watchAll(listener, [(notify) => panelStore.subscribe(notify)]),
    }),
  });
