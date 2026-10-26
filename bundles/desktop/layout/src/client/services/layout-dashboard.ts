// layout.dashboard/v1: the page the /projects dashboard shows instead of the
// project list, backed by the dashboard store the dashboard draws.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutDashboardV1,
  layoutDashboardMethods,
} from '../../contracts/index.js';
import { dashboardStore } from '../stores/dashboard.js';
import { watchAll } from './subscription.js';

export const createLayoutDashboard = () =>
  defineService(LayoutDashboardV1, {
    active: defineMethod({
      ...layoutDashboardMethods.active,
      execute: () => dashboardStore.getState().active,
    }),
    show: defineMethod({
      ...layoutDashboardMethods.show,
      execute: (id: string) => dashboardStore.getState().show(id),
    }),
    close: defineMethod({
      ...layoutDashboardMethods.close,
      execute: () => dashboardStore.getState().close(),
    }),
    subscribe: defineMethod({
      ...layoutDashboardMethods.subscribe,
      execute: (listener: () => void) =>
        watchAll(listener, [(notify) => dashboardStore.subscribe(notify)]),
    }),
  });
