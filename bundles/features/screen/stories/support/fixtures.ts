// Screen views as the desktop part mirrors them: the selected Project's
// views in every status a row draws, and a view of another Project the pane
// must not list.

import type { Project } from 'runtime/contracts';

import type { ScreenView } from '../../src/contracts/index.js';

export const checkoutProject = {
  id: '6f1c2a9e-3b7d-4c55-9a0e-2d8b41f7c310',
  name: 'Checkout web',
};

export const docsProject = {
  id: 'a2e94b0c-17d5-4f8a-9c3b-58d0e6f1a724',
  name: 'Docs site',
};

/** The Projects `runtime.records/v1` holds, whose names label a view. */
export const projects: readonly Project[] = [checkoutProject, docsProject].map(
  (project) => ({
    ...project,
    state: 'ready',
    configRevision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }),
);

/** `workspace.selection/v1`'s ids: the checkout Project and one of its Threads. */
export const checkoutSelection = {
  projectId: checkoutProject.id,
  threadId: '0b6d7f42-91e3-4a8c-b2d5-7c1e9f03a6b4',
};

const view = (
  id: string,
  label: string,
  status: ScreenView['status'],
  projectId = checkoutProject.id,
): ScreenView => ({ id, label, projectId, status });

export const readyView = view('view-1', 'Checkout web', {
  kind: 'ready',
  path: '/screen/7f3a9c21/',
  display: ':100',
});

export const waitingView = view('view-2', 'Storybook preview', {
  kind: 'waiting',
});

export const failedView = view('view-3', 'Payment sandbox', {
  kind: 'failed',
});

export const missingXpraView = view('view-4', 'Minimal image', {
  kind: 'unavailable',
  reason: 'missing-xpra',
});

export const sandboxView = view('view-5', 'Staging browser', {
  kind: 'unavailable',
  reason: 'sandbox',
});

export const startFailedView = view('view-6', 'Second display', {
  kind: 'unavailable',
  reason: 'start-failed',
});

export const otherProjectView = view(
  'view-7',
  'Docs site',
  { kind: 'ready', path: '/screen/b04e6d15/', display: ':101' },
  docsProject.id,
);

export const longLabelView = view(
  'view-8',
  'Checkout web — Chromium with the payment provider sandbox and devtools open',
  { kind: 'ready', path: '/screen/e92c0a47/', display: ':102' },
);
