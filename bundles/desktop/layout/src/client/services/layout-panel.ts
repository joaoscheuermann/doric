// layout.panel/v2 (ui-redesign S36): selects the Project panel's view, backed
// by the panel store the workspace view draws. The panel is always shown.

import { defineMethod, defineService } from 'bundle/contracts';

import { LayoutPanelV2, layoutPanelMethods } from '../../contracts/index.js';
import { panelStore } from '../stores/panel.js';

/**
 * Provides `layout.panel/v2` with only `select`, which sets the panel store's
 * selected view. Returns the service definition; it never fails at creation.
 */
export const createLayoutPanel = () =>
  defineService(LayoutPanelV2, {
    select: defineMethod({
      ...layoutPanelMethods.select,
      execute: (id: string) => panelStore.getState().select(id),
    }),
  });
