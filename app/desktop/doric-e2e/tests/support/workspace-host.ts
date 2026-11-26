// The host side of a workspace window: the Projects and Threads of the
// prototype (Figma `99:8035`, `99:8508`, `85:7520`) that the real core,
// layout, resources, chat, files and git bundles read. `runtime/v2` and
// `runtime.threads/v1` are the generated Connect services `workspace-connect`
// serves from these values; `files/v1` and `git.commands/v1` are served
// through `filesRoutes(host)` and `gitRoutes(host)`, and `usage/v1` and
// `resources/v1` as the window's `UsageService` and `ResourcesService` (slice
// S65d).

import type { ConnectRouter, ServiceImpl } from '@connectrpc/connect';
import {
  CreateDirectoryResponseSchema,
  CreateFileResponseSchema,
} from 'files/contracts/gen/doric/files/v1/files_pb.js';
import { DiscardResponseSchema } from 'git/contracts/gen/doric/git/commands/v1/commands_pb.js';
import {
  HostResponseSchema,
  ProjectResponseSchema,
  ResourcesService,
} from 'resources/contracts/gen/doric/resources/v1/resources_pb.js';
import {
  CompactionTargetResponseSchema,
  ThreadResponseSchema,
  UsageService,
} from 'usage/contracts/gen/doric/usage/v1/usage_pb.js';

import type { FakeHost } from './harness';
import { EXECUTION, serveSettingsConnect } from './settings-host';
import { serveWorkspaceConnect } from './workspace-connect';
import {
  CHANGED_FILE,
  CWD,
  conversation,
  filesRoutes,
  type GitCalls,
  gitRoutes,
  proto,
  serveFiles,
  serveGit,
  serveSandbox,
  type ThreadEventRow,
} from './workspace-content';

/** A fixed moment, so every record reads the same on every run. */
const EPOCH = '2026-01-05T09:00:00.000Z';

const at = (minutesAgo: number): string =>
  new Date(Date.parse(EPOCH) - minutesAgo * 60_000).toISOString();

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly state: 'ready' | 'queued';
  readonly configRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceThread {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly origin?: 'user' | 'agent';
  readonly name: string;
  readonly state: 'ready' | 'running';
  readonly activePromptId?: string;
  readonly executionStartedAt?: string;
  readonly lastSequence: number;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const DAY = 1_440;

/**
 * A Project last active `minutesAgo` and created `createdMinutesAgo` before
 * `EPOCH`, so the Dashboard's Activity and Created columns read the
 * prototype's relative times at the captures' clock (`FROZEN_NOW`, `85:7520`).
 * No `color` draws the hollow dot.
 */
const project = (
  id: string,
  name: string,
  color: string | undefined,
  minutesAgo: number,
  createdMinutesAgo: number,
  state: WorkspaceProject['state'] = 'ready',
): WorkspaceProject => ({
  id,
  name,
  ...(color === undefined ? {} : { color }),
  state,
  configRevision: 1,
  createdAt: at(createdMinutesAgo),
  updatedAt: at(minutesAgo),
});

const thread = (
  id: string,
  projectId: string,
  name: string,
  minutesAgo: number,
  more: Partial<
    Pick<
      WorkspaceThread,
      | 'parentThreadId'
      | 'origin'
      | 'lastSequence'
      | 'state'
      | 'activePromptId'
      | 'executionStartedAt'
    >
  > = {},
): WorkspaceThread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: CWD,
  createdAt: at(minutesAgo + 60),
  updatedAt: at(minutesAgo),
  ...more,
});

/** The Project the Project view shows, with its two prototype tabs. */
export const CHECKOUT = project(
  '11111111-1111-4111-8111-111111111111',
  'Checkout redesign',
  'violet',
  4,
  12 * DAY,
);
export const DOCS = project(
  '22222222-2222-4222-8222-222222222222',
  'Docs site',
  'teal',
  60,
  30 * DAY,
);
export const BILLING = project(
  '33333333-3333-4333-8333-333333333333',
  'Billing service',
  'amber',
  DAY,
  45 * DAY,
);

/**
 * Every Project of the workspace, in the order the sidebar lists them
 * (`85:7520`, which leaves out "Fresh workspace"; it stays first here). The
 * activity read answers them most recently active first, as the Recent rows
 * and the table show them: Fresh workspace (just now), Checkout redesign
 * (4 minutes), Docs site (1 hour), Mobile onboarding (3 hours, Queued, no
 * colour), Billing service (1 day), Pricing research (4 days).
 */
export const PROJECTS: readonly WorkspaceProject[] = [
  project(
    '66666666-6666-4666-8666-666666666666',
    'Fresh workspace',
    'blue',
    1,
    1,
  ),
  CHECKOUT,
  DOCS,
  BILLING,
  project(
    '44444444-4444-4444-8444-444444444444',
    'Mobile onboarding',
    undefined,
    180,
    3 * DAY,
    'queued',
  ),
  project(
    '55555555-5555-4555-8555-555555555555',
    'Pricing research and the long tail of competitor plans',
    'pink',
    4 * DAY,
    60 * DAY,
  ),
];

// The Threads of Checkout redesign, as the prototype's sidebar draws them
// (`269:31402`, in `99:8035` and `99:8508`), in its order:
//
//   Plan the checkout flow            main, the open Thread
//   ├ Build the payment form          sub-thread, running for 02:00
//   │ └ Validate card numbers         agent thread
//   └ Review error copy               sub-thread
//   Accessibility audit               main
//   Untitled                          main, no name yet

const PLAN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAYMENT_FORM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** What the Threads of the prototype said, by Thread. */
const LOGS: ReadonlyMap<string, readonly ThreadEventRow[]> = new Map(
  [PLAN_ID, PAYMENT_FORM_ID].map((threadId) => [
    threadId,
    conversation({ projectId: CHECKOUT.id, threadId, at: at(5) }),
  ]),
);

/** A Thread's durable log, as `watchThread` replays it. */
export const logOf = (threadId: string): readonly ThreadEventRow[] =>
  LOGS.get(threadId) ?? [];

/**
 * When the running Thread's agent started: two minutes before `EPOCH`, so
 * its elapsed badge reads the prototype's 02:00 at the captures' clock
 * (`FROZEN_NOW`).
 */
export const RUNNING_SINCE = at(2);

/** The page clock the captures freeze: just past `EPOCH`. */
export const FROZEN_NOW = Date.parse(EPOCH) + 500;

/** The Thread the Project view opens (`99:8035`): selected, with children. */
export const PLAN = thread(PLAN_ID, CHECKOUT.id, 'Plan the checkout flow', 5, {
  lastSequence: logOf(PLAN_ID).length,
});

/**
 * A sub-thread of the open Thread whose agent is running: the sidebar's
 * elapsed badge and shimmer, and the viewer of `99:8508`.
 */
export const PAYMENT_FORM = thread(
  PAYMENT_FORM_ID,
  CHECKOUT.id,
  'Build the payment form',
  4,
  {
    parentThreadId: PLAN_ID,
    origin: 'user',
    state: 'running',
    activePromptId: 'aaaaaaaa-0000-4000-8000-000000000002',
    executionStartedAt: RUNNING_SINCE,
    lastSequence: logOf(PAYMENT_FORM_ID).length,
  },
);

/** The thread an agent opened under the running one: the bot mark, depth 2. */
export const VALIDATE_CARDS = thread(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  CHECKOUT.id,
  'Validate card numbers',
  3,
  { parentThreadId: PAYMENT_FORM_ID, origin: 'agent' },
);

export const THREADS: readonly WorkspaceThread[] = [
  PLAN,
  PAYMENT_FORM,
  VALIDATE_CARDS,
  thread(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    CHECKOUT.id,
    'Review error copy',
    30,
    { parentThreadId: PLAN_ID, origin: 'user' },
  ),
  thread(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    CHECKOUT.id,
    'Accessibility audit',
    120,
  ),
  // No name yet: the sidebar draws its "Untitled" placeholder.
  thread('ffffffff-ffff-4fff-8fff-ffffffffffff', CHECKOUT.id, '', 240),
];

/** The model the prototype's footers name. */
const MODEL = EXECUTION.model;

/** One Thread's own charges in a usage answer. */
const charges = (
  item: WorkspaceThread,
  cost: number,
  calls: number,
  inputTokens: number,
) => ({
  threadId: item.id,
  name: item.name,
  ...(item.parentThreadId === undefined
    ? {}
    : { parentThreadId: item.parentThreadId }),
  calls,
  unpricedCalls: 0,
  cost,
  inputTokens,
  outputTokens: Math.round(inputTokens / 8),
  cachedInputTokens: Math.round(inputTokens / 2),
  reasoningTokens: Math.round(inputTokens / 20),
});

/** A `usage/v1` answer: the context in use and the subtree's charges summed. */
const usageOf = (
  inputTokens: number,
  threads: readonly ReturnType<typeof charges>[],
) => ({
  context: {
    model: MODEL,
    contextWindowSource: 'catalog',
    contextWindow: 200_000,
    inputTokens,
  },
  total: threads.reduce(
    (sum, entry) => ({
      calls: sum.calls + entry.calls,
      unpricedCalls: sum.unpricedCalls + entry.unpricedCalls,
      cost: sum.cost + entry.cost,
      inputTokens: sum.inputTokens + entry.inputTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + entry.cachedInputTokens,
      reasoningTokens: sum.reasoningTokens + entry.reasoningTokens,
    }),
    {
      calls: 0,
      unpricedCalls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
  ),
  threads,
});

const PAYMENT_FORM_CHARGES = [
  charges(PAYMENT_FORM, 0.3, 9, 96_000),
  charges(VALIDATE_CARDS, 0.12, 4, 31_000),
];

/**
 * What the footers read for each Thread (`99:8035`: "64.3K / 200K · 32%",
 * "~$1.75"; `99:8508`'s viewer: "38.2K / 200K · 19%", "~$0.42"). A Thread
 * without usage answers no calls, which the footer draws as "—".
 */
const USAGE: ReadonlyMap<string, ReturnType<typeof usageOf>> = new Map([
  [
    PLAN.id,
    usageOf(64_300, [
      charges(PLAN, 1.33, 21, 212_000),
      ...PAYMENT_FORM_CHARGES,
    ]),
  ],
  [PAYMENT_FORM.id, usageOf(38_200, PAYMENT_FORM_CHARGES)],
]);

/** The Project view of Checkout redesign. */
export const PROJECT_PATH = `/projects/${CHECKOUT.id}`;

/** Checkout redesign with its Thread open (`99:8035`): the chat bundle's route. */
export const THREAD_PATH = `${PROJECT_PATH}/threads/${PLAN.id}`;


const GIB = 1024 ** 3;

/** The `UsageService` handlers of each host, as `serveUsage` added them. */
const usageHandlers = new WeakMap<
  FakeHost,
  Partial<ServiceImpl<typeof UsageService>>
>();

/** Adds `handlers` to the `UsageService` of `host`. */
export const serveUsage = (
  host: FakeHost,
  handlers: Partial<ServiceImpl<typeof UsageService>>,
): void => {
  usageHandlers.set(host, { ...usageHandlers.get(host), ...handlers });
};

/**
 * Registers the `UsageService` handlers `serveUsage` added for `host` on
 * `router` (none: nothing is registered).
 */
export const usageRoutes =
  (host: FakeHost) =>
  (router: ConnectRouter): void => {
    const handlers = usageHandlers.get(host);
    if (handlers !== undefined) router.service(UsageService, handlers);
  };

/** The `ResourcesService` handlers of each host, as its fakes added them. */
const resourcesHandlers = new WeakMap<
  FakeHost,
  Partial<ServiceImpl<typeof ResourcesService>>
>();

/** Adds `handlers` to the `ResourcesService` of `host`. */
export const serveResources = (
  host: FakeHost,
  handlers: Partial<ServiceImpl<typeof ResourcesService>>,
): void => {
  resourcesHandlers.set(host, {
    ...resourcesHandlers.get(host),
    ...handlers,
  });
};

/**
 * Registers the `ResourcesService` handlers `serveResources` added for `host`
 * on `router` (none: nothing is registered).
 */
export const resourcesRoutes =
  (host: FakeHost) =>
  (router: ConnectRouter): void => {
    const handlers = resourcesHandlers.get(host);
    if (handlers !== undefined) router.service(ResourcesService, handlers);
  };

/**
 * Serves the workspace's Projects, Threads and their conversations through
 * the runtime's and the chat's Connect services, the resource readings
 * (`resources/v1`), the footers' charges (`usage/v1`), the files and Git
 * state (`workspace-content`), and the settings bundle's host contracts
 * (`settings-host`); answers the `git.commands/v1` calls made.
 */
export const serveWorkspace = (host: FakeHost): GitCalls => {
  serveUsage(host, {
    // A Thread without usage answers no calls, which the footer draws as "—".
    thread: ({ threadId }) =>
      proto(
        ThreadResponseSchema,
        THREADS.some((item) => item.id === threadId)
          ? {
              threadUsage: USAGE.get(threadId) ?? {
                total: usageOf(0, []).total,
                threads: [],
              },
            }
          : {},
      ),
    compactionTarget: () =>
      proto(CompactionTargetResponseSchema, { pressurePercent: 80 }),
  });
  serveResources(host, {
    host: () =>
      proto(HostResponseSchema, {
        at: EPOCH,
        cpuCount: 8,
        cpuPercent: 23,
        loadAverage: 1.4,
        memoryTotalBytes: 16 * GIB,
        memoryUsedBytes: 6.2 * GIB,
        uptimeSeconds: 86_400,
      }),
    project: () =>
      proto(ProjectResponseSchema, {
        status: 'ready',
        value: {
          status: 'ready',
          at: EPOCH,
          cpuPercent: 12,
          cpuCount: 4,
          memoryUsedBytes: 1.1 * GIB,
          memoryLimitBytes: 4 * GIB,
        },
      }),
  });

  serveWorkspaceWrites(host);
  const git = serveSandbox(host);
  // The window's Connect calls (S65a: the runtime's records and the chat;
  // S65c: the settings' host contracts and `git.commands/v1`; S65d:
  // `files/v1`, `usage/v1` and `resources/v1`): the same Projects, Threads
  // and logs, chat's agent mark, the settings, the Git state, the sandbox
  // and the footers' readings. What stays on the envelope is the `runtime/v2`
  // and `runtime.threads/v1` handlers above.
  host.forwardConnect(
    serveWorkspaceConnect({
      routes: (router) => {
        serveSettingsConnect(router);
        gitRoutes(host)(router);
        filesRoutes(host)(router);
        usageRoutes(host)(router);
        resourcesRoutes(host)(router);
      },
    }).forward,
  );

  return git;
};

/** The name New file and New folder answer `exists` for (A9, A10). */
export const TAKEN_NAME = 'checkout.tsx';

/** The path Discard changes refuses: a file with a merge conflict (A11). */
export const REFUSED_DISCARD = CHANGED_FILE;

/**
 * The §4.4 writes: `files/v1` `createFile` and `createDirectory` (over
 * Connect, through `filesRoutes(host)`) create every name but `TAKEN_NAME`,
 * which is refused as `exists`; `git.commands/v1` `discard` discards every
 * target but `REFUSED_DISCARD`, refused with the host's merge-conflict
 * sentence. Nothing is written: later reads answer as before.
 */
const serveWorkspaceWrites = (host: FakeHost): void => {
  const create = (directory: string, name: string) => ({
    status: 'ready',
    value:
      name === TAKEN_NAME
        ? { status: 'refused', reason: 'exists' }
        : {
            status: 'created',
            path: directory === '' ? name : `${directory}/${name}`,
          },
  });

  serveFiles(host, {
    createFile: ({ directory, name }) =>
      proto(CreateFileResponseSchema, create(directory, name)),
    createDirectory: ({ directory, name }) =>
      proto(CreateDirectoryResponseSchema, create(directory, name)),
  });
  serveGit(host, {
    discard: ({ paths, all }) =>
      proto(
        DiscardResponseSchema,
        !all && paths.includes(REFUSED_DISCARD)
          ? {
              status: 'refused',
              message: `${REFUSED_DISCARD} has a merge conflict. Resolve it before discarding.`,
            }
          : {
              status: 'ready',
              value: { discarded: all ? [CHANGED_FILE] : paths },
            },
      ),
  });
};
