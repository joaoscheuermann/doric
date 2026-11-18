// workspace.sidebar/v1 (and, until step 4(e), layout.sidebar/v1; WP-10P,
// R-9.4): rows other bundles add under each Thread of the sidebar tree.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type LayoutSidebarV1,
  type ThreadRows,
  type WorkspaceSidebarV1,
  workspaceSidebarMethods,
} from '../../contracts/index.js';
import { addThreadRows } from '../stores/thread-rows.js';

/** The sidebar service under `ref`; both ids add to the one rows store. */
export const createWorkspaceSidebar = (
  ref: typeof WorkspaceSidebarV1 | typeof LayoutSidebarV1,
) =>
  defineService(ref, {
    addThreadRows: defineMethod({
      ...workspaceSidebarMethods.addThreadRows,
      execute: (rows: ThreadRows) => addThreadRows(rows),
    }),
  });
