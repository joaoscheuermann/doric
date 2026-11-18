// The layout's own story fixtures (bundle isolation 4(c), decision S7): the
// shell reads no Project or Thread, so its stories hold only what the frame
// draws: the viewer tabs another bundle opened, keyed by the owner
// `workspace` names, the two route strings the frame's forms follow, and
// stand-in items for the navigation's slots, which `workspace` fills.

import type { RegionItem } from './fake-host.js';

/** The Project the stories' routes name. */
export const projectId = '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b';
/** The Thread the conversation shows; also the owner of its viewer tabs. */
export const owner = '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a';
/** A child Thread the chat opened as a viewer tab. */
export const childThreadId = '4e2f6a8b-0c3d-4e5f-9a1b-2c3d4e5f6a7b';
/** The Thread's name the conversation's placeholder states. */
export const conversationLabel = 'Conversation: Plan the checkout';

/** The path the window shows when the Thread is selected. */
export const threadRoute = `/projects/${projectId}/threads/${owner}`;
/** The path the window shows when only the Project is selected. */
export const projectRoute = `/projects/${projectId}`;

/** The tabs a reader opened beside the Thread's conversation. */
export const checkoutTabs = {
  [owner]: [
    {
      id: 'file:src/components/Checkout.tsx',
      title: 'Checkout.tsx',
      tag: 'files-viewer',
      iconTag: 'files-file-icon',
      props: { path: 'src/components/Checkout.tsx' },
    },
    {
      id: 'diff:src/components/PaymentForm.tsx',
      title: 'PaymentForm.tsx',
      tag: 'git-diff-viewer',
      iconTag: 'git-file-diff-icon',
      props: { path: 'src/components/PaymentForm.tsx' },
    },
    {
      id: `thread:${childThreadId}`,
      title: 'Build the payment form',
      tag: 'chat-thread-panel',
      iconTag: 'chat-thread-tab-icon',
      openBottom: true,
      props: { projectId, threadId: childThreadId },
    },
  ],
} as const;

/** The items `workspace` adds to the navigation's slots, as stand-ins. */
export const navigationStandIns: Readonly<
  Record<string, readonly RegionItem[]>
> = {
  'shell.sidebar': [
    { id: 'navigation', tag: 'workspace-sidebar', owner: 'workspace' },
  ],
  'shell.titlebar.tabs': [
    { id: 'project-tabs', tag: 'workspace-project-tabs', owner: 'workspace' },
  ],
};

/** The Dashboard's stand-ins: with them the frame draws its page form. */
export const dashboardStandIns: Readonly<
  Record<string, readonly RegionItem[]>
> = {
  ...navigationStandIns,
  'shell.page': [
    { id: 'dashboard', tag: 'workspace-dashboard', owner: 'workspace' },
  ],
  'shell.sidebar.footer': [
    {
      id: 'dashboard-footer',
      tag: 'workspace-sidebar-footer',
      owner: 'workspace',
    },
  ],
};
