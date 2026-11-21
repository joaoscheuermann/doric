import { useSyncExternalStore } from 'react';

import { dashboardStore } from '../stores/dashboard.js';

const active = (): string | undefined => dashboardStore.getState().active;

/** The id of the page the /projects dashboard shows; `undefined` for the list. */
export const useDashboardPage = (): string | undefined =>
  useSyncExternalStore(dashboardStore.subscribe, active, active);
