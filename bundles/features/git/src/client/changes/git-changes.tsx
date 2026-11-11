// <git-changes> (stage 10, §3.8): the Changes view of the Project panel,
// moved from the provisional `ProjectFilesContent` (`project-files-sidebar.tsx`)
// and `ChangesView`: the panel's one toast surface for the tree and changes
// reads, the gate over the files tree read that explains a Project whose
// sandbox cannot be read, and the changed paths of the repositories the
// selected Thread's working directory reaches. A row opens its comparison;
// the row of the current comparison tab is the selected one. A changed file
// and a repository can be discarded from their context menus (§4.4 A11, A12)
// behind a confirmation.

import { CommandsV1, type Services } from 'bundle/contracts';
import { PanelState, ReadFeedback, TreeSkeleton } from 'desktop/ui/panels';
import { ScrollArea } from 'desktop/ui/scroll-area';
import { SidebarMenu } from 'desktop/ui/sidebar';
import { sandboxNotice } from 'files/contracts';
import { LayoutTabsV1 } from 'layout/contracts';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { Thread } from 'runtime/contracts';
import { useStore } from 'zustand/react';

import {
  type ChangesObservation,
  type Discard,
  OPEN_COMPARISON_COMMAND,
  type ProjectChange,
} from '../../contracts/index.js';
import {
  type FilesSandbox,
  FilesSandboxV1,
  type TreeObservation,
} from '../api/peers.js';
import { comparedPathOf } from '../commands.js';
import { useChanges } from '../hooks/use-changes.js';
import { useProjectReads } from '../hooks/use-project-reads.js';
import { useSelection } from '../hooks/use-selection.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { changedRepositories } from '../reads/change-tree.js';
import {
  gitClient,
  requestProjectRefresh,
  settleProjectRefresh,
} from '../state.js';
import { ChangesTree } from './changes-tree.js';
import { DiscardDialog, type DiscardTarget } from './discard-dialog.js';
import { collapsedOf, collapsedScope, rootOf } from './store.js';

/** The toast id the panel's views share (Q6): one read toast per panel. */
export const PANEL_READ_TOAST = 'layout-panel-read';

const idleTree: TreeObservation = {
  read: { status: 'idle' },
  fetching: false,
};

export function GitChangesView({ services }: { readonly services: Services }) {
  const selection = useSelection(services);
  const tabs = useService(services, LayoutTabsV1);
  const commands = useService(services, CommandsV1);
  const files = useService(services, FilesSandboxV1);
  const selectedPath = useSubscribed(
    tabs,
    () => comparedPathOf((tabs as NonNullable<typeof tabs>).current()),
    undefined,
  );
  const projectId = selection.project?.id;
  const cwd = selection.thread?.cwd;
  const tree = useTree(files, projectId, cwd);
  const changes = useChanges(projectId, cwd);
  useProjectReads(projectId);
  const discard = useDiscard(selection.thread);
  const open = useCallback(
    (repository: string, change: ProjectChange) => {
      if (projectId === undefined) return;
      void commands
        ?.execute(OPEN_COMPARISON_COMMAND, {
          projectId,
          repository,
          path: change.path,
        })
        .catch(() => undefined);
    },
    [commands, projectId],
  );

  if (!selection.available) return null;

  const treeError = tree?.error;
  const changesError = changes.error;

  return (
    <>
      <ReadFeedback
        error={treeError ?? changesError}
        refreshing={tree?.fetching === true || changes.fetching}
        onRetry={() => {
          if (projectId !== undefined) requestProjectRefresh(projectId);
        }}
        toastId={PANEL_READ_TOAST}
      />
      <SandboxGate tree={tree} projectId={projectId}>
        {projectId !== undefined && (
          <ChangesView
            changes={changes}
            scope={collapsedScope(projectId, rootOf(cwd))}
            selectedPath={selectedPath}
            onOpen={open}
            onDiscard={discard.request}
          />
        )}
      </SandboxGate>
      <DiscardDialog
        target={discard.target}
        pending={discard.pending}
        message={discard.message}
        onConfirm={discard.confirm}
        onOpenChange={discard.openChange}
      />
    </>
  );
}

/** The sentence a Discard that did not complete shows in its dialog (§4.4). */
export const discardMessage = (outcome: Discard | undefined): string => {
  switch (outcome?.status) {
    case 'refused':
    case 'failed':
      return outcome.message;
    case 'missing':
      return 'This Thread no longer exists.';
    case 'inactive':
      return 'This Thread is not running. Open it and try again.';
    case 'pending':
      return 'The Project is starting. Try again in a moment.';
    default:
      return 'Could not discard the changes.';
  }
};

interface DiscardState {
  readonly target: DiscardTarget | null;
  readonly pending: boolean;
  readonly message?: string;
}

const closed: DiscardState = { target: null, pending: false };

/**
 * The Discard dialog's state over the selected Thread: a menu entry asks for a
 * target; confirming sends `discard` with the working directory the view read
 * with. A `ready` or `failed` answer waits for the Project's refresh, so the
 * tree shows what is left before the dialog closes or says what failed; every
 * other answer leaves the workspace as it was and only says why. Without a
 * Thread nothing can be discarded and the rows have no menu.
 */
function useDiscard(thread: Thread | undefined) {
  const [state, setState] = useState<DiscardState>(closed);
  const request = useCallback(
    (target: DiscardTarget) => setState({ target, pending: false }),
    [],
  );
  const openChange = useCallback((open: boolean) => {
    if (!open) setState(closed);
  }, []);
  const { target, pending } = state;
  const confirm = useCallback(() => {
    if (target === null || pending || thread === undefined) return;
    setState({ target, pending: true });
    void (async () => {
      let outcome: Discard | undefined;
      try {
        const client = gitClient();
        if (client === undefined) throw new Error('No git client.');
        outcome = await client.store.api().discard({
          threadId: thread.id,
          cwd: thread.cwd,
          repository: target.repository,
          ...(target.paths === undefined ? {} : { paths: target.paths }),
        });
      } catch {
        outcome = undefined;
      }
      if (outcome?.status === 'ready' || outcome?.status === 'failed')
        await settleProjectRefresh(thread.projectId).catch(() => undefined);
      setState(
        outcome?.status === 'ready'
          ? closed
          : { target, pending: false, message: discardMessage(outcome) },
      );
    })();
  }, [target, pending, thread]);
  return {
    ...state,
    request: thread === undefined ? undefined : request,
    confirm,
    openChange,
  };
}

/**
 * The files tree read of the same Project and root, while this view shows
 * it and the files bundle serves one: the gate the Changes view always had.
 */
function useTree(
  files: FilesSandbox | undefined,
  projectId: string | undefined,
  cwd: string | undefined,
): TreeObservation | undefined {
  const [state, setState] = useState<TreeObservation | undefined>(undefined);
  useEffect(() => {
    if (files === undefined) {
      setState(undefined);
      return;
    }
    if (projectId === undefined) {
      setState(idleTree);
      return;
    }
    const observation = files.observeTree(
      { projectId, ...(cwd === undefined ? {} : { cwd }) },
      setState,
    );
    return () => observation.dispose();
  }, [files, projectId, cwd]);
  return state;
}

/**
 * What the panel shows when the sandbox itself cannot be read: a queued,
 * failed or terminated Project has no changes, so the surface explains the
 * Project instead of failing the view. One tree read settles whether the
 * sandbox is readable; without the files bundle there is none to wait for.
 */
function SandboxGate({
  children,
  tree,
  projectId,
}: {
  readonly children: ReactNode;
  readonly tree: TreeObservation | undefined;
  readonly projectId?: string;
}) {
  if (projectId === undefined) {
    return (
      <PanelState
        description="Select a project to see its sandbox."
        title="No project selected"
      />
    );
  }
  if (tree === undefined) return children;
  const { read } = tree;
  if (read.status === 'idle' || read.status === 'loading') {
    // A read on its way — and the error, when there is one, is what failed it.
    if (tree.error !== undefined) return null;
    return <TreeSkeleton root label="Loading changes" />;
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

/** Changed paths grouped by repository; selecting a row opens its comparison. */
function ChangesView({
  changes,
  scope,
  selectedPath,
  onOpen,
  onDiscard,
}: {
  readonly changes: ChangesObservation;
  readonly scope: string;
  readonly selectedPath?: string;
  readonly onOpen: (repository: string, change: ProjectChange) => void;
  readonly onDiscard?: (target: DiscardTarget) => void;
}) {
  const store = gitClient()?.store.collapsed;
  if (store === undefined) return null;
  return (
    <ChangesList
      changes={changes}
      collapsedStore={store}
      scope={scope}
      selectedPath={selectedPath}
      onOpen={onOpen}
      onDiscard={onDiscard}
    />
  );
}

function ChangesList({
  changes,
  collapsedStore,
  scope,
  selectedPath,
  onOpen,
  onDiscard,
}: {
  readonly changes: ChangesObservation;
  readonly collapsedStore: NonNullable<
    ReturnType<typeof gitClient>
  >['store']['collapsed'];
  readonly scope: string;
  readonly selectedPath?: string;
  readonly onOpen: (repository: string, change: ProjectChange) => void;
  readonly onDiscard?: (target: DiscardTarget) => void;
}) {
  const collapsed = useStore(collapsedStore, (state) =>
    collapsedOf(state, scope),
  );
  const toggle = useCallback(
    (key: string) => collapsedStore.getState().toggle(scope, key),
    [collapsedStore, scope],
  );
  const { read } = changes;
  const repositories = read.status === 'ready' ? read.value.repositories : [];

  if (read.status === 'idle') {
    if (changes.error !== undefined) return null;
    return (
      <PanelState
        description="The changes have not been read yet."
        title="No changes read"
      />
    );
  }
  if (read.status === 'loading')
    return <TreeSkeleton root label="Loading changes" />;
  if (read.status !== 'ready') {
    return (
      <PanelState
        description={sandboxNotice(read.status, read.retryAfterSeconds)}
        title="The changes cannot be read"
      />
    );
  }
  if (repositories.length === 0) {
    return (
      <PanelState
        description="This directory holds no git repository."
        title="No repositories"
      />
    );
  }

  const changed = changedRepositories(repositories);
  if (changed.length === 0) {
    return (
      <PanelState
        description="This workspace has no uncommitted changes."
        title="No changes"
      />
    );
  }

  return (
    <ScrollArea scrollbars="both" className="min-h-0 w-full flex-1">
      <SidebarMenu role="tree" className="w-max min-w-full gap-0 px-1 py-1">
        {changed.map((repository) => (
          <ChangesTree
            key={repository.path}
            repository={repository}
            collapsed={collapsed}
            selectedPath={selectedPath}
            onToggle={toggle}
            onOpen={onOpen}
            onDiscard={onDiscard}
          />
        ))}
      </SidebarMenu>
    </ScrollArea>
  );
}
