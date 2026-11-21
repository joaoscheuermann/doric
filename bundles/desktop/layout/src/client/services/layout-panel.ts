// layout.panel/v3 (bundle isolation 4a): select the Project panel's view,
// backed by the panel store the workspace view draws. The panel is always
// shown, and it starts with no view selected.

import { defineMethod, defineService } from 'bundle/contracts';

import { LayoutPanelV3, layoutPanelMethods } from '../../contracts/index.js';
import { panelStore } from '../stores/panel.js';

/**
 * Provides `layout.panel/v3` with only `select`, which sets the panel store's
 * selected view. Returns the service definition; it never fails at creation.
 */
export const createLayoutPanelV3 = () =>
  defineService(LayoutPanelV3, {
    select: defineMethod({
      ...layoutPanelMethods.select,
      execute: (id: string) => panelStore.getState().select(id),
    }),
  });
