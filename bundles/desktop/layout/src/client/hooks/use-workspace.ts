import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RouteMatch } from 'bundle/contracts';
import { ClientError, errorFrom } from 'desktop/reads';
import { toast } from 'desktop/ui/sonner';
import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';

import {
  isDescribed,
  type Selection,
  threadsOf,
} from '../domain/project-tree.js';
import { routeIntent } from '../domain/route-selection.js';
import type { WorkspaceError } from '../domain/sidebar.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  RuntimeRecords,
  Thread,
} from '../domain/workspace.js';
import { queryKeys } from '../queries/keys.js';
import { rewriteRoute } from '../stores/route-selection.js';
import {
  awaitRead,
  boundRecords,
  workspaceStore,
} from '../stores/workspace.js';
import { createThreadNavigation } from './thread-navigation.js';
import { useRouteSelection } from './use-route-selection.js';

export type WorkspaceActions = {
  /**
   * Archives the Thread and its idle, unpinned descendants
   * (`archiveThread` of `runtime.records/v1`), which puts every answered record
   * into the mirror, then
   * shows the toast "Thread archived" / `"<name or Untitled>" moved to
   * Archived` whose Undo restores that batch (docs/designs/thread-archive.md
   * §10.6). A failure is stored as the workspace error (no retry target) and
   * shows no toast. Never rejects.
   */
  readonly archiveThread: (thread: Thread) => Promise<void>;
  readonly beginProject: () => void;
  readonly beginThread: (projectId: string, parentThreadId?: string) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly confirmDelete: () => Promise<void>;
  readonly copyThreadId: (id: string) => void;
  readonly createProject: (name: string) => Promise<void>;
  readonly createThread: (name: string) => Promise<void>;
  readonly dismissDelete: () => void;
  readonly rename: (entity: Entity, name: string) => Promise<void>;
  readonly requestDelete: (entity: Entity) => void;
  /**
   * Restores the Thread's batch: `batch` when given (Undo), else the
   * Thread's own (`restoreThread` of `runtime.records/v1`), which puts every
   * answered record into the mirror.
   * Shows no toast. A failure is stored as the workspace error. Never
   * rejects.
   */
  readonly restoreThread: (thread: Thread, batch?: string) => Promise<void>;
  /**
   * Clears the error, then loads its retry target again: the Projects list
   * for `{ kind: 'projects' }`, that Project's Threads for `{ kind: 'threads' }`.
   * Without an error, or with an error that has no target, it does nothing.
   * A load that fails again stores its error with the same target; one that
   * succeeds leaves no error. Never throws or rejects.
   */
  readonly retryError: () => void;
  readonly selectProject: (project: Project) => void;
  readonly selectThread: (thread: Thread) => void;
  readonly setProjectColor: (project: Project, color?: ProjectColor) => void;
  /**
   * Pins or unpins the Thread (`setThreadPinned` of `runtime.records/v1`),
   * which puts the answered record into the mirror. A failure is stored as the workspace error. Never
   * rejects.
   */
  readonly setThreadPinned: (thread: Thread, pinned: boolean) => Promise<void>;
  readonly startRename: (entity: Entity) => void;
};

/**
 * Everything the workspace page shows and everything the user can ask it to do:
 * the Projects and Threads it knows, the dialogs in progress, and the one error a
 * failed request surfaces. The rules behind these transitions are pure and live
 * in `@/domain/project-tree` and `@/domain/sidebar`.
 */
export type Workspace = {
  readonly actions: WorkspaceActions;
  readonly deleting?: Entity;
  readonly deletingPending: boolean;
  readonly draft?: Draft;
  readonly editing?: Entity;
  /** The one workspace error, with its retry target when it has one (§8). */
  readonly error?: WorkspaceError;
  readonly loadingProjectThreads: ReadonlySet<string>;
  readonly loadingProjects: boolean;
  readonly projects: readonly Project[];
  readonly selectedProjectId?: string;
  readonly selectedThread?: Thread;
  readonly selectedThreadId?: string;
  /**
   * The Threads described for each Project, so every open row can render its own
   * subtree instead of only the selected Project's.
   */
  readonly threadsByProject: Readonly<Record<string, readonly Thread[]>>;
};

/** One counter per key, so work started before the last one cannot land after it. */
const nextSequence = (sequences: Map<string, number>, key: string): number => {
  const sequence = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, sequence);
  return sequence;
};

/**
 * The mirror bound now, read anew at each call; without one a call fails as
 * an unreachable backend does.
 */
const records = (): RuntimeRecords => {
  const bound = boundRecords();
  if (bound === undefined) {
    throw new ClientError('unavailable', 'Doric backend is unavailable.');
  }
  return bound;
};

const isCurrentSequence = (
  sequences: Map<string, number>,
  key: string,
  sequence: number,
): boolean => sequences.get(key) === sequence;

export const useWorkspace = (): Workspace => {
  const queryClient = useQueryClient();
  // The store's actions are stable and read the current state through the store;
  // this hook only ever calls them.
  const store = workspaceStore.getState();
  const tree = useStore(workspaceStore, (state) => state.tree);
  const sidebar = useStore(workspaceStore, (state) => state.sidebar);
  const loadingProjects = useStore(
    workspaceStore,
    (state) => state.loadingProjects,
  );
  const loadingProjectThreads = useStore(
    workspaceStore,
    (state) => state.loadingProjectThreads,
  );
  /** Interaction intent, so work started before the last one cannot land after it. */
  const intent = useRef(0);
  /** Interaction intent at mount, so a late selection restore cannot win. */
  const restoreIntent = useRef(intent.current);
  const loadSequences = useRef(new Map<string, number>());
  /** The mount the Projects loads belong to; an unmount ends it. */
  const mounts = useRef(0);
  const mutationSequences = useRef(new Map<string, number>());

  // Memoized so the mount effect that starts the first Threads load can list it
  // as a dependency without the load running again on every render. Its own
  // dependencies are the store's stable actions and the stable query client.
  const loadThreads = useCallback(
    async (projectId: string): Promise<void> => {
      const requestIntent = intent.current;
      const sequence = nextSequence(loadSequences.current, projectId);
      store.beginThreadsLoad(projectId);
      store.request(projectId);
      const read = await awaitRead({ target: 'threads', projectId });
      if (isCurrentSequence(loadSequences.current, projectId, sequence)) {
        if (read.status === 'failed') {
          if (intent.current === requestIntent) {
            store.fail(read.error, { kind: 'threads', projectId });
          }
        } else {
          store.settle({ kind: 'threads', projectId });
        }
        store.endThreadsLoad(projectId);
      }
    },
    [
      store.beginThreadsLoad,
      store.request,
      store.settle,
      store.fail,
      store.endThreadsLoad,
    ],
  );

  /** Discards loads already in flight for a Project whose Threads just changed. */
  const invalidateLoads = (projectId: string): void => {
    nextSequence(loadSequences.current, projectId);
    store.endThreadsLoad(projectId);
  };

  // Memoized so the mount effect and `retryError` share one Projects load. A
  // load lands only in the mount that started it, and its failure only while
  // no newer reader intent has started.
  const loadProjects = useCallback(async (): Promise<void> => {
    const mount = mounts.current;
    const requestIntent = intent.current;
    const active = () => mounts.current === mount;
    const read = await awaitRead({ target: 'projects' });
    if (!active()) return;
    if (read.status === 'failed') {
      if (intent.current === requestIntent) {
        store.fail(read.error, { kind: 'projects' });
      }
    } else {
      const projects = workspaceStore.getState().tree.projects;
      const selected = workspaceStore.getState().tree.selection.projectId;
      if (selected && !projects.some((project) => project.id === selected)) {
        store.select({});
        rewriteRoute();
      }
      store.settle({ kind: 'projects' });
    }
    store.setLoadingProjects(false);
  }, [store.select, store.settle, store.fail, store.setLoadingProjects]);

  useEffect(() => {
    void loadProjects();
    return () => {
      mounts.current += 1;
    };
    // The workspace loads its Projects once; `loadProjects` is stable, so
    // listing it keeps the load from running again.
  }, [loadProjects]);

  const selectMissingThreadProject = (projectId: string): Selection => {
    const current = workspaceStore.getState();
    const listed = boundRecords()?.projects().value;
    const projects =
      current.loadingProjects || listed === undefined
        ? listed
        : current.tree.projects;
    const selection =
      projects === undefined ||
      projects.some((project) => project.id === projectId)
        ? { projectId }
        : {};
    store.select(selection);
    if (selection.projectId) void loadThreads(selection.projectId);
    return selection;
  };

  /** Selects what a navigation the layout did not make names (rule 5). */
  const followRoute = (match: RouteMatch | undefined): void => {
    const intended = routeIntent(match, workspaceStore.getState().tree);
    if (intended.kind === 'none') return;
    intent.current += 1;
    if (intended.kind === 'canonical') {
      rewriteRoute();
      return;
    }
    if (intended.kind === 'home') {
      store.select({});
      return;
    }
    if (intended.kind === 'project') {
      store.select({ projectId: intended.projectId });
      void loadThreads(intended.projectId);
      return;
    }
    if (intended.kind === 'select') {
      void openThread(intended.thread, false);
      return;
    }
    const requestIntent = intent.current;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.thread(intended.threadId),
        queryFn: () => records().findThread({ threadId: intended.threadId }),
      })
      .then(
        (thread) => {
          if (intent.current !== requestIntent) return;
          if (thread === undefined) {
            rewriteRoute(selectMissingThreadProject(intended.projectId));
            return;
          }
          void openThread(thread, false);
        },
        () => {
          if (intent.current === requestIntent) rewriteRoute();
        },
      );
  };

  const { changeSelection, markUserSelection } = useRouteSelection({
    isCurrent: () => intent.current === restoreIntent.current,
    onRestore: (thread) => {
      intent.current += 1;
      return openThread(thread, false).then((selection) => selection ?? null);
    },
    onMissingProject: selectMissingThreadProject,
    get: (id) => records().findThread({ threadId: id }),
    onRoute: followRoute,
  });

  /** A selection the user made is pushed onto the window history (rule 3). */
  const userSelection = (selection: Selection): void => {
    markUserSelection(selection);
  };

  const openThread = createThreadNavigation({
    intent,
    loadThreads,
    userSelection,
  });

  /**
   * The tree owns the selection; the route-selection store writes the copy
   * the window path persists. Every selection change flows through here, so
   * the path cannot drift from the selection the surfaces render.
   */
  useEffect(() => {
    // Route restoration can select synchronously in an earlier mount effect.
    // Let its next render persist instead of writing this stale snapshot.
    const current = workspaceStore.getState().tree.selection;
    if (
      current.projectId !== tree.selection.projectId ||
      current.threadId !== tree.selection.threadId
    )
      return;
    changeSelection(current);
  }, [changeSelection, tree.selection.projectId, tree.selection.threadId]);

  // The selected Project is kept current by the mirror while it is selected;
  // its notices reach the tree through `sync`.
  const followedProjectId = tree.selection.projectId;
  useEffect(() => {
    if (followedProjectId === undefined) return;
    const follow = boundRecords()?.follow({ projectId: followedProjectId });
    return () => follow?.dispose();
  }, [followedProjectId]);

  const { mutateAsync: createProjectWrite } = useMutation({
    mutationFn: (name: string): Promise<Project> =>
      records().createProject({ name }),
  });
  const { mutateAsync: renameProjectWrite } = useMutation({
    mutationFn: ({
      id,
      name,
    }: {
      id: string;
      name: string;
    }): Promise<Project> => records().renameProject({ projectId: id, name }),
  });
  const { mutateAsync: setProjectColorWrite } = useMutation({
    mutationFn: ({
      id,
      color,
    }: {
      id: string;
      color?: ProjectColor;
    }): Promise<Project> =>
      records().setProjectColor({
        projectId: id,
        ...(color === undefined ? {} : { color }),
      }),
  });
  const { mutateAsync: deleteProjectWrite } = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await records().terminateProject({ projectId: id });
      await records().deleteProject({ projectId: id });
    },
  });
  const { mutateAsync: createThreadWrite } = useMutation({
    mutationFn: ({
      projectId,
      name,
      parentThreadId,
    }: {
      projectId: string;
      name: string;
      parentThreadId?: string;
    }): Promise<Thread> =>
      records().createThread({
        projectId,
        name,
        ...(parentThreadId === undefined ? {} : { parentThreadId }),
      }),
  });
  const { mutateAsync: renameThreadWrite } = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }): Promise<Thread> =>
      records().renameThread({ threadId: id, name }),
  });
  const { mutateAsync: deleteThreadWrite } = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await records().terminateThread({ threadId: id });
      await records().deleteThread({ threadId: id });
    },
  });

  const selectProject = (project: Project): void => {
    intent.current += 1;
    store.selectProject(project);
    userSelection(workspaceStore.getState().tree.selection);
    void loadThreads(project.id);
  };

  const selectThread = (thread: Thread): void => {
    intent.current += 1;
    void openThread(thread, true);
  };

  const beginProject = (): void => {
    intent.current += 1;
    store.beginProject();
  };

  const beginThread = (projectId: string, parentThreadId?: string): void => {
    intent.current += 1;
    if (tree.selection.projectId !== projectId) userSelection({ projectId });
    store.beginThread(projectId, parentThreadId);
    if (!isDescribed(tree, projectId)) void loadThreads(projectId);
  };

  const createProject = async (name: string): Promise<void> => {
    const operationIntent = intent.current;
    const sequence = nextSequence(mutationSequences.current, 'projects:create');
    try {
      const project = await createProjectWrite(name);
      // The mirror describes the created Project with no Threads (R3).
      store.request(project.id);
      let initialThread: Thread | undefined;
      try {
        initialThread = await createThreadWrite({
          projectId: project.id,
          name: '',
        });
        invalidateLoads(project.id);
      } catch (reason) {
        // The Project exists even if its first Thread failed. Open it and
        // report the failure without asking the create form to make it again.
        store.fail(reason);
      }
      if (
        isCurrentSequence(
          mutationSequences.current,
          'projects:create',
          sequence,
        ) &&
        intent.current === operationIntent
      ) {
        const selection = {
          projectId: project.id,
          ...(initialThread === undefined
            ? {}
            : { threadId: initialThread.id }),
        };
        userSelection(selection);
        store.select(selection);
        store.clearProjectDraft();
      }
    } catch (reason) {
      store.fail(reason);
      throw reason;
    }
  };

  const createThread = async (name: string): Promise<void> => {
    if (sidebar.draft?.kind !== 'thread') return;
    const operationDraft = sidebar.draft;
    const operationIntent = intent.current;
    const key = `threads:create:${operationDraft.projectId}`;
    const sequence = nextSequence(mutationSequences.current, key);
    invalidateLoads(operationDraft.projectId);
    try {
      const thread = await createThreadWrite({
        projectId: operationDraft.projectId,
        name,
        parentThreadId: operationDraft.parentThreadId,
      });
      invalidateLoads(thread.projectId);
      if (
        isCurrentSequence(mutationSequences.current, key, sequence) &&
        intent.current === operationIntent
      ) {
        await openThread(thread, true);
        store.clearThreadDraft(operationDraft);
      }
    } catch (reason) {
      store.fail(reason);
    }
  };

  const rename = async (entity: Entity, name: string): Promise<void> => {
    const key = `${entity.kind}:rename:${entity.value.id}`;
    const sequence = nextSequence(mutationSequences.current, key);
    const operationIntent = intent.current;
    try {
      if (entity.kind === 'project') {
        await renameProjectWrite({ id: entity.value.id, name });
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
      } else {
        invalidateLoads(entity.value.projectId);
        const thread = await renameThreadWrite({ id: entity.value.id, name });
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
        invalidateLoads(thread.projectId);
      }
      if (intent.current === operationIntent) {
        store.clearRename(entity);
      }
    } catch (reason) {
      store.fail(reason);
      throw reason;
    }
  };

  const setProjectColor = async (
    project: Project,
    color?: ProjectColor,
  ): Promise<void> => {
    try {
      await setProjectColorWrite({ id: project.id, color });
    } catch (reason) {
      store.fail(reason);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const entity = sidebar.deleting;
    if (entity === undefined) return;
    const operationIntent = intent.current;
    const key = `${entity.kind}:delete:${entity.value.id}`;
    const sequence = nextSequence(mutationSequences.current, key);
    store.beginDelete();
    try {
      if (entity.kind === 'project') {
        invalidateLoads(entity.value.id);
        await deleteProjectWrite(entity.value.id);
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
      } else {
        invalidateLoads(entity.value.projectId);
        await deleteThreadWrite(entity.value.id);
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
        void loadThreads(entity.value.projectId);
      }
      if (intent.current === operationIntent) store.clearDeleting();
    } catch (reason) {
      store.fail(reason);
    } finally {
      store.settleDelete();
    }
  };

  const restoreThread = async (
    thread: Thread,
    batch?: string,
  ): Promise<void> => {
    invalidateLoads(thread.projectId);
    try {
      await records().restoreThread({
        threadId: thread.id,
        ...(batch === undefined ? {} : { batch }),
      });
    } catch (reason) {
      store.fail(reason);
    }
  };

  const archiveThread = async (thread: Thread): Promise<void> => {
    invalidateLoads(thread.projectId);
    try {
      const { batch } = await records().archiveThread({ threadId: thread.id });
      toast('Thread archived', {
        description: `"${thread.name || 'Untitled'}" moved to Archived`,
        action: {
          label: 'Undo',
          onClick: () => void restoreThread(thread, batch),
        },
      });
    } catch (reason) {
      store.fail(reason);
    }
  };

  const setThreadPinned = async (
    thread: Thread,
    pinned: boolean,
  ): Promise<void> => {
    invalidateLoads(thread.projectId);
    try {
      await records().setThreadPinned({ threadId: thread.id, pinned });
    } catch (reason) {
      store.fail(reason);
    }
  };

  const actions: WorkspaceActions = {
    archiveThread,
    beginProject,
    beginThread,
    cancelDraft: () => {
      intent.current += 1;
      store.cancelDraft();
    },
    cancelRename: () => {
      intent.current += 1;
      store.cancelRename();
    },
    confirmDelete,
    copyThreadId: (id) => {
      store.clearError();
      void navigator.clipboard
        .writeText(id)
        .catch((reason: unknown) =>
          store.report(
            errorFrom(
              'clipboard_failed',
              'Unable to copy the thread ID.',
              reason,
            ),
          ),
        );
    },
    createProject,
    createThread,
    dismissDelete: () => store.dismissDelete(),
    rename,
    requestDelete: (entity) => store.requestDelete(entity),
    restoreThread,
    retryError: () => {
      const target = workspaceStore.getState().sidebar.error?.retry;
      if (target === undefined) return;
      store.clearError();
      if (target.kind === 'projects') void loadProjects();
      else void loadThreads(target.projectId);
    },
    selectProject,
    selectThread,
    setProjectColor,
    setThreadPinned,
    startRename: (entity) => {
      intent.current += 1;
      store.startRename(entity);
    },
  };

  const selectedProjectId = tree.selection.projectId;
  const selectedThreadId = tree.selection.threadId;

  const threads = threadsOf(tree, selectedProjectId);
  return {
    actions,
    deleting: sidebar.deleting,
    deletingPending: sidebar.deletingPending,
    draft: sidebar.draft,
    editing: sidebar.editing,
    error: sidebar.error,
    loadingProjects,
    loadingProjectThreads,
    projects: tree.projects,
    selectedProjectId,
    selectedThread: threads.find((thread) => thread.id === selectedThreadId),
    selectedThreadId,
    threadsByProject: tree.threadsByProject,
  };
};
