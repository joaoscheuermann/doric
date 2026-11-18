// layout.panel/v2 (ui-redesign S36) and layout.panel/v3 (bundle isolation 4a):
// select the Project panel's view, backed by the panel store the workspace
// view draws. The panel is always shown.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutPanelV2,
  LayoutPanelV3,
  layoutPanelMethods,
} from '../../contracts/index.js';
import { panelStore } from '../stores/panel.js';

const select = () =>
  defineMethod({
    ...layoutPanelMethods.select,
    execute: (id: string) => panelStore.getState().select(id),
  });

/**
 * Provides `layout.panel/v2` with only `select`, which sets the panel store's
 * selected view. Returns the service definition; it never fails at creation.
 */
export const createLayoutPanel = () =>
  defineService(LayoutPanelV2, { select: select() });

/** Provides `layout.panel/v3`, over the same panel store as v2. */
export const createLayoutPanelV3 = () =>
  defineService(LayoutPanelV3, { select: select() });
