import { SidebarScope } from 'desktop/ui/sidebar';
import { Toaster } from 'desktop/ui/sonner';
import { useState } from 'react';

import type { ChangesObservation } from '../../src/client/api/peers.js';
import { rootOf } from '../../src/client/sandbox-store.js';
import { FilesTreeView } from '../../src/client/tree/files-tree.js';
import type {
  ProjectTreeNode,
  TreeObservation,
} from '../../src/contracts/index.js';
import { seedExpansion, seedFilesClient } from '../support/files-client.js';
import {
  changeMarks,
  largeTree,
  nestedThread,
  openDirectories,
  project,
  thread,
  webTree,
  workspaceTree,
} from '../support/fixtures.js';
import { still, storyServices } from '../support/services.js';

type Selection = {
  readonly project?: typeof project;
  readonly thread?: typeof thread;
};

const ready = (entries: readonly ProjectTreeNode[]): TreeObservation => ({
  read: { status: 'ready', value: entries },
  fetching: false,
});

/**
 * The Files view of the Project panel over seeded reads: the layout's
 * selection and current tab, git's changes read (when `changes` is given),
 * and the files client's tree read.
 */
function TreeStory({
  tree,
  changes,
  selection = { project, thread },
  selectedPath,
  open = openDirectories,
}: {
  readonly tree: TreeObservation;
  readonly changes?: ChangesObservation;
  readonly selection?: Selection;
  readonly selectedPath?: string;
  readonly open?: ReadonlySet<string>;
}) {
  const [services] = useState(() => {
    seedFilesClient(tree);
    if (selection.project !== undefined) {
      seedExpansion(selection.project.id, rootOf(selection.thread?.cwd), open);
    }
    return storyServices({
      apis: {
        'layout.workspace/v1': { ...still, selection: () => selection },
        'layout.tabs/v1': {
          ...still,
          current: () =>
            selectedPath === undefined
              ? undefined
              : { id: `file:${selectedPath}` },
        },
        'commands/v1': { execute: async () => undefined },
        ...(changes === undefined
          ? {}
          : {
              'git.changes/v1': {
                observe: (
                  _scope: unknown,
                  listener: (state: ChangesObservation) => void,
                ) => {
                  listener(changes);
                  return { dispose: () => undefined };
                },
              },
            }),
      },
    });
  });
  return (
    <div
      className="flex flex-col overflow-hidden rounded-md border bg-sidebar text-sidebar-foreground"
      style={{ width: 320, height: 560 }}
    >
      <SidebarScope>
        <FilesTreeView services={services} />
      </SidebarScope>
      <Toaster />
    </div>
  );
}

export default {
  title: 'Files/Tree/Files tree',
  component: FilesTreeView,
};

export const WithChanges = {
  render: () => (
    <TreeStory
      tree={ready(workspaceTree)}
      changes={{ decorations: changeMarks, fetching: false }}
      selectedPath="apps/web/src/checkout/payment-form.tsx"
    />
  ),
};

export const WithoutGit = {
  render: () => <TreeStory tree={ready(workspaceTree)} />,
};

export const Collapsed = {
  render: () => (
    <TreeStory
      tree={ready(workspaceTree)}
      changes={{ decorations: changeMarks, fetching: false }}
      open={new Set()}
    />
  ),
};

export const RootedAtWorkingDirectory = {
  render: () => (
    <TreeStory
      tree={ready(webTree)}
      selection={{ project, thread: nestedThread }}
      open={new Set(['apps/web/src', 'apps/web/src/checkout'])}
      selectedPath="apps/web/src/main.tsx"
    />
  ),
};

export const ManyFiles = {
  render: () => (
    <TreeStory
      tree={ready(largeTree)}
      open={new Set(['fixtures'])}
      selectedPath="fixtures/order-007-with-a-long-descriptive-name.json"
    />
  ),
};

export const Refreshing = {
  render: () => (
    <TreeStory
      tree={{ ...ready(workspaceTree), fetching: true }}
      changes={{ decorations: changeMarks, fetching: true }}
    />
  ),
};

export const Loading = {
  render: () => (
    <TreeStory tree={{ read: { status: 'loading' }, fetching: true }} />
  ),
};

export const EmptyWorkspace = {
  render: () => <TreeStory tree={ready([])} />,
};

export const SandboxPending = {
  render: () => (
    <TreeStory
      tree={{
        read: { status: 'pending', retryAfterSeconds: 3 },
        fetching: false,
      }}
    />
  ),
};

export const SandboxMissing = {
  render: () => (
    <TreeStory tree={{ read: { status: 'missing' }, fetching: false }} />
  ),
};

export const SandboxExpired = {
  render: () => (
    <TreeStory tree={{ read: { status: 'expired' }, fetching: false }} />
  ),
};

export const SandboxUnavailable = {
  render: () => (
    <TreeStory tree={{ read: { status: 'unavailable' }, fetching: false }} />
  ),
};

/** A failed first read: the panel stays blank and the toast explains it. */
export const ReadFailed = {
  render: () => (
    <TreeStory
      tree={{
        read: { status: 'loading' },
        error: 'Doric backend is unavailable.',
        fetching: false,
      }}
    />
  ),
};

/** A failed reread keeps the tree on screen beside the toast. */
export const RereadFailed = {
  render: () => (
    <TreeStory
      tree={{
        ...ready(workspaceTree),
        error: 'The request could not be completed.',
      }}
    />
  ),
};

export const NoProjectSelected = {
  render: () => (
    <TreeStory
      tree={{ read: { status: 'idle' }, fetching: false }}
      selection={{}}
    />
  ),
};
