// workspace.dashboard/v1: the page the /projects dashboard shows instead of
// the project list, backed by the dashboard store the dashboard draws.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  WorkspaceDashboardV1,
  workspaceDashboardMethods,
} from '../../contracts/index.js';
import { dashboardStore } from '../stores/dashboard.js';

/** The dashboard service; it is backed by the one dashboard store. */
export const createWorkspaceDashboard = () =>
  defineService(WorkspaceDashboardV1, {
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
