import { Tabs } from 'desktop/ui/tabs';

import {
  WorkspaceTabBar,
  WorkspaceTabs,
} from '../../../src/client/components/organisms/workspace-tabs.js';
import { useWorkspaceTabs } from '../../../src/client/hooks/use-workspace-tabs.js';
import { workspaceTabsStore } from '../../../src/client/stores/workspace-tabs.js';
import { checkoutTabs, planThread } from '../../support/data.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';

const owner = planThread.id;

/** The tab bar over the tab panel, as the viewer division draws them. */
function Viewer() {
  const tabs = useWorkspaceTabs(owner);
  return (
    <Tabs
      value={tabs.selected ?? ''}
      onValueChange={(id) => workspaceTabsStore.getState().select(owner, id)}
      className="flex h-[560px] w-[34rem] flex-col gap-0 border"
    >
      <div className="flex h-10 shrink-0 items-center border-b bg-[var(--paper-panel)] px-2">
        {tabs.items.length > 0 && (
          <WorkspaceTabBar state={tabs} threadId={owner} />
        )}
      </div>
      <div className="min-h-0 flex-1">
        <WorkspaceTabs state={tabs} />
      </div>
    </Tabs>
  );
}

const opened: LayoutFixture = { tabs: checkoutTabs };
const single: LayoutFixture = {
  tabs: { [owner]: checkoutTabs[owner].slice(0, 1) },
};
const terminals: LayoutFixture = {
  tabs: {
    [owner]: [
      {
        id: 'terminal:dev',
        title: 'npm run dev',
        tag: 'terminal-tab',
        icon: 'terminal',
      },
      {
        id: 'terminal:test',
        title: 'npm test -- --watch',
        tag: 'terminal-tab',
        icon: 'terminal',
      },
    ],
  },
};
const many: LayoutFixture = {
  tabs: {
    [owner]: [
      'Checkout.tsx',
      'PaymentForm.tsx',
      'OrderSummary.tsx',
      'CouponField.tsx',
      'checkout.test.ts',
      'payment-intents.ts',
      'README.md',
    ].map((name) => ({
      id: `file:src/${name}`,
      title: name,
      tag: 'files-viewer',
      icon: 'file' as const,
      props: { path: `src/${name}` },
    })),
  },
};

export default {
  title: 'Layout/Organisms/Workspace tabs',
  component: WorkspaceTabs,
};

/** A file, a diff and a child Thread open; the child Thread is selected. */
export const FileDiffAndThread = {
  render: () => (
    <LayoutHost fixture={opened}>
      <Viewer />
    </LayoutHost>
  ),
};

export const SingleTab = {
  render: () => (
    <LayoutHost fixture={single}>
      <Viewer />
    </LayoutHost>
  ),
};

export const Terminals = {
  render: () => (
    <LayoutHost fixture={terminals}>
      <Viewer />
    </LayoutHost>
  ),
};

/** More tabs than the bar holds. */
export const ManyTabs = {
  render: () => (
    <LayoutHost fixture={many}>
      <Viewer />
    </LayoutHost>
  ),
};

/** Every tab closed: the bar and the panel are empty. */
export const NoTabs = {
  render: () => (
    <LayoutHost>
      <Viewer />
    </LayoutHost>
  ),
};
