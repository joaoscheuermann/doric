// workspace.dashboard/v1 (and, until step 4(e), layout.dashboard/v1): the page
// the /projects dashboard shows instead of the project list, backed by the
// dashboard store the dashboard draws.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type LayoutDashboardV1,
  type WorkspaceDashboardV1,
  workspaceDashboardMethods,
} from '../../contracts/index.js';
import { dashboardStore } from '../stores/dashboard.js';

/** The dashboard service under `ref`; both ids are backed by the one store. */
export const createWorkspaceDashboard = (
  ref: typeof WorkspaceDashboardV1 | typeof LayoutDashboardV1,
) =>
  defineService(ref, {
    active: defineMethod({
      ...workspaceDashboardMethods.active,
      execute: () => dashboardStore.getState().active,
    }),
    show: defineMethod({
      ...workspaceDashboardMethods.show,
      execute: (id: string) => dashboardStore.getState().show(id),
    }),
    close: defineMethod({
      ...workspaceDashboardMethods.close,
      execute: () => dashboardStore.getState().close(),
    }),
    subscribe: defineMethod({
      ...workspaceDashboardMethods.subscribe,
      execute: (listener: () => void) => {
        const stop = dashboardStore.subscribe(() => listener());
        return { dispose: () => stop() };
      },
    }),
  });
