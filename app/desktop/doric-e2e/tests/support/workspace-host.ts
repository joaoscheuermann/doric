// The host side of a workspace window: the Projects and Threads of the
// prototype (Figma `99:8035`, `85:7520`), answered over the fake host for
// what the real core, layout and resources bundles call
// (`runtime/v1`, `runtime.threads/v1`, `resources/v1`).

import type { FixtureBundle } from '../../../doric/tests/support/distribution';
import type { FakeHost } from './harness';

/** A fixed moment, so every record reads the same on every run. */
const EPOCH = '2026-01-05T09:00:00.000Z';

const at = (minutesAgo: number): string =>
  new Date(Date.parse(EPOCH) - minutesAgo * 60_000).toISOString();

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly state: 'ready';
  readonly configRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceThread {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly state: 'ready';
  readonly lastSequence: number;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const project = (
  id: string,
  name: string,
  color: string,
  minutesAgo: number,
): WorkspaceProject => ({
  id,
  name,
  color,
  state: 'ready',
  configRevision: 1,
  createdAt: at(minutesAgo + 600),
  updatedAt: at(minutesAgo),
});

const thread = (
  id: string,
  projectId: string,
  name: string,
  minutesAgo: number,
): WorkspaceThread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace/checkout',
  createdAt: at(minutesAgo + 60),
  updatedAt: at(minutesAgo),
});

/** The Project the Project view shows, with its two prototype tabs. */
export const CHECKOUT = project(
  '11111111-1111-4111-8111-111111111111',
  'Checkout redesign',
  'violet',
  5,
);
export const DOCS = project(
  '22222222-2222-4222-8222-222222222222',
  'Docs site',
  'teal',
  40,
);
export const BILLING = project(
  '33333333-3333-4333-8333-333333333333',
  'Billing service',
  'amber',
  180,
);

/** Every Project of the workspace, most recently active first. */
export const PROJECTS: readonly WorkspaceProject[] = [
  project('66666666-6666-4666-8666-666666666666', 'Fresh workspace', 'blue', 1),
  CHECKOUT,
  DOCS,
  BILLING,
  project(
    '44444444-4444-4444-8444-444444444444',
    'Mobile onboarding',
    'green',
    1_440,
  ),
  project(
    '55555555-5555-4555-8555-555555555555',
    'Pricing research and the long tail of competitor plans',
    'pink',
    4_320,
  ),
];

/** The Thread the Project view selects. */
export const PAYMENT_FORM = thread(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  CHECKOUT.id,
  'Build the payment form',
  5,
);

export const THREADS: readonly WorkspaceThread[] = [
  thread(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    CHECKOUT.id,
    'Plan the checkout flow',
    90,
  ),
  PAYMENT_FORM,
];

/** The Project view of Checkout redesign. */
export const PROJECT_PATH = `/projects/${CHECKOUT.id}`;

/**
 * Checkout redesign with its Thread open (`99:8035`). The chat bundle
 * registers this route; without it the outlet has nothing to show there.
 */
export const THREAD_PATH = `${PROJECT_PATH}/threads/${PAYMENT_FORM.id}`;

/**
 * A stand-in for the chat bundle's Thread route (2f-2 brings the real one):
 * `THREAD_PATH` under the workspace, drawing an empty conversation. The
 * layout opens a Project on its latest Thread, so without this route a
 * Project view has nothing registered to show.
 */
export const threadRouteFixture: FixtureBundle = {
  id: 'thread-route',
  requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
  files: {
    'client/index.js': `import { NavigationV1 } from 'bundle/contracts';
export function activate({ services }) {
  const route = services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: () => {
      const view = document.createElement('div');
      view.dataset.slot = 'thread-route-fixture';
      view.style.cssText = 'display: flex; flex: 1; min-height: 0';
      return view;
    },
  });
  return () => route.dispose();
}
`,
  },
};

/** A tuple's first item, or the value: the argument a wire message carries. */
const first = (input: unknown): Record<string, unknown> => {
  const value = Array.isArray(input) ? input[0] : input;

  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

const GIB = 1024 ** 3;

/** Serves the workspace's Projects, Threads and resource readings. */
export const serveWorkspace = (host: FakeHost): void => {
  const threadsOf = (projectId: unknown) =>
    THREADS.filter((item) => item.projectId === projectId);

  host.serve('runtime/v1', 'projects', () => ({ items: [...PROJECTS] }));
  host.serve('runtime/v1', 'project', (input) => {
    const id = Array.isArray(input) ? input[0] : input;

    return PROJECTS.find((item) => item.id === id);
  });
  host.serve('runtime/v1', 'projectActivity', () =>
    PROJECTS.map((item) => ({
      project: item,
      activityAt: item.updatedAt,
      ...(threadsOf(item.id).length > 0
        ? { latestActiveThreadId: PAYMENT_FORM.id }
        : {}),
    })),
  );
  host.stream('runtime/v1', 'watchProject', (input, push) => {
    const { projectId } = first(input);

    push({
      kind: 'snapshot',
      projectId,
      project: PROJECTS.find((item) => item.id === projectId) ?? null,
      threads: threadsOf(projectId),
      terminals: [],
    });
  });
  host.serve('runtime.threads/v1', 'threads', (input) => ({
    items: threadsOf(first(input).projectId),
  }));
  host.serve('runtime.threads/v1', 'thread', (input) => {
    const id = Array.isArray(input) ? input[0] : input;

    return THREADS.find((item) => item.id === id);
  });
  host.serve('resources/v1', 'host', () => ({
    at: EPOCH,
    cpuCount: 8,
    cpuPercent: 23,
    loadAverage: 1.4,
    memoryTotalBytes: 16 * GIB,
    memoryUsedBytes: 6.2 * GIB,
    uptimeSeconds: 86_400,
  }));
  host.serve('resources/v1', 'project', () => ({
    status: 'ready',
    value: {
      status: 'ready',
      at: EPOCH,
      cpuPercent: 12,
      cpuCount: 4,
      memoryUsedBytes: 1.1 * GIB,
      memoryLimitBytes: 4 * GIB,
    },
  }));
};
