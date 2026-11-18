// workspace.sidebar/v1 (WP-10P, R-9.4): rows other bundles add under each
// Thread of the sidebar tree.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type ThreadRows,
  WorkspaceSidebarV1,
  workspaceSidebarMethods,
} from '../../contracts/index.js';
import { addThreadRows } from '../stores/thread-rows.js';

/** The sidebar service; it adds to the one rows store. */
export const createWorkspaceSidebar = () =>
  defineService(WorkspaceSidebarV1, {
    addThreadRows: defineMethod({
      ...workspaceSidebarMethods.addThreadRows,
      execute: (rows: ThreadRows) => addThreadRows(rows),
    }),
  });
