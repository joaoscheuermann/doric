import { useSyncExternalStore } from 'react';

import { api } from '../api/settings-api.js';

const subscribe = (listener: () => void): (() => void) => {
  const subscription = api().dashboard.subscribe(listener);
  return () => subscription.dispose();
};

const active = (): string | undefined => api().dashboard.active();

/**
 * The id of the page the /projects dashboard shows (`layout.dashboard/v1`),
 * `undefined` while it shows the project list or without a dashboard.
 */
export const useDashboardPage = (): string | undefined =>
  useSyncExternalStore(subscribe, active, active);
