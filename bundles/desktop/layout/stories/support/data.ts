// The Projects, Threads and activity the layout stories draw: a small but
// realistic workspace, the way the host describes it. Every id is a UUID,
// because the workspace adapter checks them as the REST routes did.

import type { Project, Thread } from '../../src/client/domain/workspace.js';

/** An ISO time `minutes` before the story loaded. */
export const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const project = (
  id: string,
  name: string,
  color: Project['color'],
  createdDaysAgo: number,
  updatedMinutesAgo: number,
  state: Project['state'] = 'ready',
): Project => ({
  id,
  name,
  ...(color === undefined ? {} : { color }),
  state,
  configRevision: 1,
  createdAt: minutesAgo(createdDaysAgo * 1_440),
  updatedAt: minutesAgo(updatedMinutesAgo),
});

export const checkout = project(
  '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b',
  'Checkout redesign',
  'violet',
  12,
  4,
);
export const docs = project(
  '0b7e9d21-3c4f-4a5b-9c6d-7e8f9a0b1c2d',
  'Docs site',
  'teal',
  30,
  95,
);
export const billing = project(
  'a2c4e6f8-1b3d-4f5a-8b7c-9d0e1f2a3b4c',
  'Billing service',
  'amber',
  45,
  1_600,
);
export const mobile = project(
  'c3d5e7f9-2a4b-4c6d-9e8f-0a1b2c3d4e5f',
  'Mobile onboarding',
  undefined,
  3,
  220,
  'queued',
);
export const research = project(
  'd4e6f8a0-3b5c-4d7e-8f9a-1b2c3d4e5f6a',
  'Pricing research and the long tail of competitor plans',
  'pink',
  60,
  6_000,
);
export const empty = project(
  'e5f7a9b1-4c6d-4e8f-9a0b-2c3d4e5f6a7b',
  'Fresh workspace',
  'blue',
  0,
  1,
);

export const projects: readonly Project[] = [
  checkout,
  docs,
  billing,
  mobile,
  research,
];

const thread = (
  id: string,
  projectId: string,
  name: string,
  fields: Partial<Thread> = {},
): Thread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 42,
  cwd: '/workspace',
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(20),
  ...fields,
});

export const planThread = thread(
  '11111111-1111-4111-8111-111111111111',
  checkout.id,
  'Plan the checkout flow',
  { cwdRepo: 'github', lastExecutionMs: 84_000 },
);
export const formThread = thread(
  '22222222-2222-4222-8222-222222222222',
  checkout.id,
  'Build the payment form',
  {
    parentThreadId: planThread.id,
    cwdRepo: 'git',
    state: 'running',
    activePromptId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    executionStartedAt: minutesAgo(2),
  },
);
export const validationThread = thread(
  '33333333-3333-4333-8333-333333333333',
  checkout.id,
  'Validate card numbers',
  { parentThreadId: formThread.id, lastExecutionMs: 12_500 },
);
export const copyThread = thread(
  '44444444-4444-4444-8444-444444444444',
  checkout.id,
  'Review error copy',
  { parentThreadId: planThread.id, lastExecutionMs: 3_200 },
);
export const auditThread = thread(
  '55555555-5555-4555-8555-555555555555',
  checkout.id,
  'Accessibility audit',
  { lastExecutionMs: 260_000 },
);
export const untitledThread = thread(
  '66666666-6666-4666-8666-666666666666',
  checkout.id,
  '',
);
export const docsThread = thread(
  '77777777-7777-4777-8777-777777777777',
  docs.id,
  'Migrate the docs to MDX',
  { cwdRepo: 'github' },
);
export const billingThread = thread(
  '88888888-8888-4888-8888-888888888888',
  billing.id,
  'Retry failed invoices',
  { state: 'failed', errorCode: 'tool_failed' },
);
export const mobileThread = thread(
  '99999999-9999-4999-8999-999999999999',
  mobile.id,
  'Draft the welcome screens',
);
export const researchThread = thread(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  research.id,
  'Compare the plans of the five closest competitors in one table',
);

export const checkoutThreads: readonly Thread[] = [
  planThread,
  formThread,
  validationThread,
  copyThread,
  auditThread,
  untitledThread,
];

export const threads: readonly Thread[] = [
  ...checkoutThreads,
  docsThread,
  billingThread,
  mobileThread,
  researchThread,
];

/** A long list of root Threads, for overflow. */
export const manyThreads: readonly Thread[] = Array.from(
  { length: 24 },
  (_, index) =>
    thread(
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
      checkout.id,
      [
        'Fix the coupon field',
        'Update the order summary',
        'Add Apple Pay',
        'Write the release notes',
      ][index % 4] ?? 'Thread',
      { cwdRepo: index % 3 === 0 ? 'git' : undefined },
    ),
);

/** The path the window shows when a Thread is selected. */
export const threadRoute = (selected: Thread): string =>
  `/projects/${selected.projectId}/threads/${selected.id}`;

export const projectRoute = (selected: Project): string =>
  `/projects/${selected.id}`;

/** The tabs a reader opened beside the plan Thread's conversation. */
export const checkoutTabs = {
  [planThread.id]: [
    {
      id: 'file:src/components/Checkout.tsx',
      title: 'Checkout.tsx',
      tag: 'files-viewer',
      icon: 'file',
      props: { path: 'src/components/Checkout.tsx' },
    },
    {
      id: 'diff:src/components/PaymentForm.tsx',
      title: 'PaymentForm.tsx',
      tag: 'git-diff-viewer',
      icon: 'file-diff',
      props: { path: 'src/components/PaymentForm.tsx' },
    },
    {
      id: `thread:${formThread.id}`,
      title: formThread.name,
      tag: 'chat-thread-panel',
      icon: 'thread',
      props: { projectId: checkout.id, threadId: formThread.id },
    },
  ],
} as const;
