// layout.sidebar/v1 (WP-10P, R-9.4): rows other bundles add under each
// Thread of the sidebar tree.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutSidebarV1,
  layoutSidebarMethods,
  type ThreadRows,
} from '../../contracts/index.js';
import { addThreadRows } from '../stores/thread-rows.js';

export const createLayoutSidebar = () =>
  defineService(LayoutSidebarV1, {
    addThreadRows: defineMethod({
      ...layoutSidebarMethods.addThreadRows,
      execute: (rows: ThreadRows) => addThreadRows(rows),
    }),
  });
