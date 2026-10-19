import { SidebarMenu, SidebarScope } from 'desktop/ui/sidebar';
import { type ComponentType, useState } from 'react';

import {
  ThreadBranches,
  type ThreadBranchesActions,
} from '../../../src/client/components/molecules/thread-branches.js';
import { threadIconKind } from '../../../src/client/domain/sidebar.js';
import { threadLevel } from '../../../src/client/domain/thread-tree.js';
import type { Draft, Thread } from '../../../src/client/domain/workspace.js';
import {
  checkout,
  checkoutThreads,
  formThread,
  kindThreads,
  manyThreads,
  planThread,
  validationThread,
} from '../../support/data.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';

const report =
  (name: string) =>
  (...args: readonly unknown[]) =>
    console.info(`Story action: ${name}`, ...args);

/** One tree with its own selection, collapse and rename state. */
function ThreadTree({
  draft,
  editing,
  fixture,
  initialCollapsed = [],
  selected = planThread.id,
  threads = checkoutThreads,
}: {
  readonly draft?: Draft;
  readonly editing?: string;
  readonly fixture?: LayoutFixture;
  readonly initialCollapsed?: readonly string[];
  readonly selected?: string;
  readonly threads?: readonly Thread[];
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(selected);
  const [editingId, setEditingId] = useState(editing);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    new Set(initialCollapsed),
  );
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const actions: ThreadBranchesActions = {
    beginChild: report('beginChild'),
    cancelDraft: report('cancelDraft'),
    cancelRename: () => setEditingId(undefined),
    copyId: report('copyId'),
    create: (name) => {
      report('create')(name);
      return Promise.resolve();
    },
    delete: report('delete'),
    rename: (thread, name) => {
      report('rename')(thread.id, name);
      setEditingId(undefined);
      return Promise.resolve();
    },
    select: (thread) => setSelectedId(thread.id),
    startRename: (thread) => setEditingId(thread.id),
  };

  return (
    <LayoutHost fixture={fixture}>
      <SidebarMenu className="w-full gap-0">
        <ThreadBranches
          actions={actions}
          collapsed={collapsed}
          depth={0}
          editingThreadId={editingId}
          repo={threadIconKind}
          level={threadLevel(threads, draft, checkout.id)}
          onExpand={(id) =>
            setCollapsed((current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            })
          }
          onToggle={toggle}
          selectedThreadId={selectedId}
        />
      </SidebarMenu>
    </LayoutHost>
  );
}

const terminals: LayoutFixture = {
  terminalRows: { [planThread.id]: 1, [validationThread.id]: 2 },
};

export default {
  title: 'Layout/Molecules/Thread branches',
  component: ThreadBranches,
  decorators: [
    (Story: ComponentType) => (
      <SidebarScope>
        <div className="w-64 bg-sidebar py-1 text-sidebar-foreground">
          <Story />
        </div>
      </SidebarScope>
    ),
  ],
};

/**
 * The Checkout tree: child Threads, a running agent, git and GitHub working
 * directories and an unnamed Thread.
 */
export const CheckoutTree = {
  render: () => <ThreadTree />,
};

/**
 * The three kinds in one tree: a main Thread, the sub-thread the reader opened
 * inside it, and the agent Threads an agent spawned — one running, one paused.
 * Only the main Thread offers a branch; an agent Thread offers none.
 */
export const ThreadKinds = {
  render: () => <ThreadTree threads={kindThreads} selected={formThread.id} />,
};

/** A child Thread selected deep in the tree. */
export const ChildSelected = {
  render: () => <ThreadTree selected={validationThread.id} />,
};

/** A branch collapsed: its chevron points right and its children hide. */
export const Collapsed = {
  render: () => <ThreadTree initialCollapsed={[planThread.id]} />,
};

/** A child Thread being created under the running one. */
export const DraftChild = {
  render: () => (
    <ThreadTree
      draft={{
        kind: 'thread',
        projectId: checkout.id,
        parentThreadId: formThread.id,
      }}
    />
  ),
};

/** A Thread being renamed in place. */
export const Renaming = {
  render: () => <ThreadTree editing={formThread.id} />,
};

/** Terminal rows another bundle adds under two Threads. */
export const WithTerminalRows = {
  render: () => <ThreadTree fixture={terminals} />,
};

/** Many root Threads, for overflow. */
export const ManyThreads = {
  render: () => (
    <div className="max-h-96 overflow-y-auto">
      <ThreadTree threads={manyThreads} selected={manyThreads[2]?.id} />
    </div>
  ),
};
