// <files-tree> (stage 10, §3.6): the Files view of the Project panel, moved
// from the provisional `ProjectFilesContent` (`project-files-sidebar.tsx`):
// one toast surface for the tree and changes reads, the gate that explains a
// Project whose sandbox cannot be read, and the whole tree rooted at the
// selected Thread's working directory, decorated from git's changes read when
// git serves one. A file row opens its tab; the row of the current file tab
// is the selected one.

import { CommandsV1, type Services } from 'bundle/contracts';
import {
  changeDecorations,
  emptyDirectoryNotice,
  sandboxNotice,
} from 'desktop-reads';
import { ScrollArea } from 'desktop-ui/scroll-area';
import { SidebarMenu } from 'desktop-ui/sidebar';
import {
  FileTree,
  type FileTreeActions,
  PanelState,
  ReadFeedback,
  TreeSkeleton,
} from 'desktop-ui/workspace';
import { LayoutTabsV1, LayoutWorkspaceV1 } from 'layout/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { useStore } from 'zustand/react';

import {
  OPEN_FILE_COMMAND,
  type TreeObservation,
} from '../../contracts/index.js';
import {
  type ChangesObservation,
  type GitChanges,
  GitChangesV1,
} from '../api/peers.js';
import { filePathOf } from '../commands.js';
import { useProjectReads } from '../hooks/use-project-reads.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { rootOf } from '../sandbox-store.js';
import { filesClient } from '../state.js';
import {
  emptyExpansion,
  expansionScope,
  expansionStore,
} from '../stores/expansion.js';

/** The toast id the panel's views share (Q6): one read toast per panel. */
export const PANEL_READ_TOAST = 'layout-panel-read';

const idleTree: TreeObservation = {
  read: { status: 'idle' },
  fetching: false,
};

type Location = {
  readonly projectId?: string;
  readonly cwd?: string;
};

const locationKey = (location: Location): string =>
  JSON.stringify([location.projectId ?? null, location.cwd ?? null]);

const locationOf = (key: string): Location => {
  const [projectId, cwd] = JSON.parse(key) as [string | null, string | null];
  return {
    ...(projectId === null ? {} : { projectId }),
    ...(cwd === null ? {} : { cwd }),
  };
};

export function FilesTreeView({ services }: { readonly services: Services }) {
  const workspace = useService(services, LayoutWorkspaceV1);
  const tabs = useService(services, LayoutTabsV1);
  const commands = useService(services, CommandsV1);
  const git = useService(services, GitChangesV1);
  const location = locationOf(
    useSubscribed(
      workspace,
      () => {
        const { project, thread } = (
          workspace as NonNullable<typeof workspace>
        ).selection();
        return locationKey({ projectId: project?.id, cwd: thread?.cwd });
      },
      locationKey({}),
    ),
  );
  const selectedPath = useSubscribed(
    tabs,
    () => filePathOf((tabs as NonNullable<typeof tabs>).current()?.id),
    undefined,
  );
  const { projectId, cwd } = location;
  const tree = useTree(projectId, cwd);
  const changes = useChanges(git, projectId, cwd);
  useProjectReads(projectId);

  if (workspace === undefined) return null;

  const root = rootOf(cwd);
  const treeError = tree.error;
  const changesError = changes?.error;

  return (
    <>
      <ReadFeedback
        error={treeError ?? changesError}
        refreshing={tree.fetching || changes?.fetching === true}
        onRetry={() => {
          if (projectId !== undefined)
            filesClient()?.coordinator.request(projectId);
        }}
        toastId={PANEL_READ_TOAST}
      />
      <SandboxGate tree={tree} projectId={projectId}>
        {projectId !== undefined && (
          <FilesView
            entries={tree.read.status === 'ready' ? tree.read.value : []}
            scope={expansionScope(projectId, root)}
            selectedPath={selectedPath}
            changes={changes}
            onOpen={(path) => {
              void commands
                ?.execute(OPEN_FILE_COMMAND, { projectId, path })
                .catch(() => undefined);
            }}
          />
        )}
      </SandboxGate>
    </>
  );
}

/** The tree read of one Project and root, while this view shows it. */
function useTree(
  projectId: string | undefined,
  cwd: string | undefined,
): TreeObservation {
  const [state, setState] = useState<TreeObservation>(idleTree);
  useEffect(() => {
    const client = filesClient();
    if (projectId === undefined || client === undefined) {
      setState(idleTree);
      return;
    }
    const observation = client.store.observeTree(
      { projectId, ...(cwd === undefined ? {} : { cwd }) },
      setState,
    );
    return () => observation.dispose();
  }, [projectId, cwd]);
  return state;
}

/** Git's changes read of the same Project and root, when git serves one. */
function useChanges(
  git: GitChanges | undefined,
  projectId: string | undefined,
  cwd: string | undefined,
): ChangesObservation | undefined {
  const [state, setState] = useState<ChangesObservation | undefined>(undefined);
  useEffect(() => {
    if (git === undefined || projectId === undefined) {
      setState(undefined);
      return;
    }
    const observation = git.observe(
      { projectId, ...(cwd === undefined ? {} : { cwd }) },
      setState,
    );
    return () => observation.dispose();
  }, [git, projectId, cwd]);
  return state;
}

/**
 * What the panel shows when the sandbox itself cannot be read: a queued,
 * failed or terminated Project has no files, so the surface explains the
 * Project instead of failing the view. One tree read settles both what the
 * sandbox holds and whether it is readable.
 */
function SandboxGate({
  children,
  tree,
  projectId,
}: {
  readonly children: ReactNode;
  readonly tree: TreeObservation;
  readonly projectId?: string;
}) {
  const { read } = tree;
  if (projectId === undefined) {
    return (
      <PanelState
        description="Select a project to see its sandbox."
        title="No project selected"
      />
    );
  }
  if (read.status === 'idle' || read.status === 'loading') {
    // A read on its way — and the error, when there is one, is what failed it.
    if (tree.error !== undefined) return null;
    return <TreeSkeleton changes={false} />;
  }
  if (read.status !== 'ready') {
    return (
      <PanelState
        description={sandboxNotice(read.status, read.retryAfterSeconds)}
        title="No files to show"
      />
    );
  }
  return children;
}

/**
 * The directory tree, read whole. A file row opens its tab beside this panel
 * rather than replacing the tree, so what was opened stays reachable.
 */
function FilesView({
  entries,
  scope,
  selectedPath,
  changes,
  onOpen,
}: {
  readonly entries: TreeEntries;
  readonly scope: string;
  readonly selectedPath?: string;
  readonly changes?: ChangesObservation;
  readonly onOpen: (path: string) => void;
}) {
  const expanded = useStore(
    expansionStore,
    (state) => state.views[scope] ?? emptyExpansion,
  );
  const actions: FileTreeActions = {
    open: onOpen,
    toggle: (path) => expansionStore.getState().toggle(scope, path),
  };

  if (entries.length === 0) {
    return <PanelState description={emptyDirectoryNotice} title="No files" />;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <SidebarMenu role="tree" className="w-full gap-0 py-1">
        <FileTree
          actions={actions}
          depth={0}
          entries={entries}
          expanded={expanded}
          selectedPath={selectedPath}
          decorations={changeDecorations(
            changes?.read.status === 'ready'
              ? changes.read.value.repositories
              : [],
          )}
        />
      </SidebarMenu>
    </ScrollArea>
  );
}

type TreeEntries = Extract<
  TreeObservation['read'],
  { readonly status: 'ready' }
>['value'];
