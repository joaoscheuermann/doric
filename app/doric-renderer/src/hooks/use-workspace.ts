import { isDescribed, threadsOf } from '@/domain/project-tree';
import {
  type Draft,
  type Entity,
  type Project,
  type ProjectColor,
  type Thread,
} from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { workspaceStore } from '@/stores/workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';

import { usePersistedSelection } from './use-persisted-selection';
import { useProjectEvents } from './use-project-events';

export type WorkspaceActions = {
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
  readonly selectProject: (project: Project) => void;
  readonly selectThread: (thread: Thread) => void;
  readonly setProjectColor: (project: Project, color?: ProjectColor) => void;
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
  readonly error?: string;
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
  const mutationSequences = useRef(new Map<string, number>());

  const loadThreads = async (projectId: string): Promise<void> => {
    const requestIntent = intent.current;
    const sequence = nextSequence(loadSequences.current, projectId);
    store.beginThreadsLoad(projectId);
    try {
      const threads = await queryClient.fetchQuery({
        queryKey: queryKeys.threads(projectId),
        queryFn: () => window.doric.threads.list(projectId),
      });
      if (!isCurrentSequence(loadSequences.current, projectId, sequence))
        return;
      store.applyThreads(projectId, threads);
    } catch (reason) {
      if (
        isCurrentSequence(loadSequences.current, projectId, sequence) &&
        intent.current === requestIntent
      ) {
        store.fail(reason);
      }
    } finally {
      if (isCurrentSequence(loadSequences.current, projectId, sequence)) {
        store.endThreadsLoad(projectId);
      }
    }
  };

  /** Discards loads already in flight for a Project whose Threads just changed. */
  const invalidateLoads = (projectId: string): void => {
    nextSequence(loadSequences.current, projectId);
    void queryClient.cancelQueries({ queryKey: queryKeys.threads(projectId) });
    store.endThreadsLoad(projectId);
  };

  useEffect(() => {
    let active = true;
    const initialIntent = intent.current;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.projects,
        queryFn: () => window.doric.projects.list(),
      })
      .then((projects) => {
        if (!active) return;
        store.applyProjects(projects);
        const first = projects[0];
        if (first && intent.current === initialIntent) {
          store.select({ projectId: first.id });
          void loadThreads(first.id);
        }
      })
      .catch((reason: unknown) => {
        if (active && intent.current === initialIntent) {
          store.fail(reason);
        }
      })
      .finally(() => {
        if (active) store.setLoadingProjects(false);
      });
    return () => {
      active = false;
    };
    // The workspace loads its Projects once; the actions it settles through are
    // stable.
  }, []);

  const { setSelectedThreadId } = usePersistedSelection({
    isCurrent: () => intent.current === restoreIntent.current,
    onRestore: (thread) => {
      intent.current += 1;
      store.select({ projectId: thread.projectId, threadId: thread.id });
      void loadThreads(thread.projectId);
    },
    get: (id) => window.doric.threads.get(id),
  });

  /**
   * The tree owns the selection; the selection store keeps the copy it persists.
   * Every selection change flows through here, so the persisted copy cannot
   * drift from the one the surfaces render.
   */
  useEffect(() => {
    setSelectedThreadId(tree.selection.threadId);
  }, [setSelectedThreadId, tree.selection.threadId]);

  useProjectEvents({
    projectId: tree.selection.projectId,
    onUpdate: (update) =>
      // Every transition advances the tree from its latest value, so
      // back-to-back updates are all kept.
      store.applyUpdate(update),
    onError: (message) => store.report(message),
  });

  const { mutateAsync: createProjectWrite } = useMutation({
    mutationFn: (name: string): Promise<Project> =>
      window.doric.projects.create(name),
  });
  const { mutateAsync: renameProjectWrite } = useMutation({
    mutationFn: ({
      id,
      name,
    }: {
      id: string;
      name: string;
    }): Promise<Project> => window.doric.projects.rename(id, name),
  });
  const { mutateAsync: setProjectColorWrite } = useMutation({
    mutationFn: ({
      id,
      color,
    }: {
      id: string;
      color?: ProjectColor;
    }): Promise<Project> => window.doric.projects.setColor(id, color),
  });
  const { mutateAsync: deleteProjectWrite } = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await window.doric.projects.terminate(id);
      await window.doric.projects.delete(id);
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
      window.doric.threads.create(projectId, name, parentThreadId),
  });
  const { mutateAsync: renameThreadWrite } = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }): Promise<Thread> =>
      window.doric.threads.rename(id, name),
  });
  const { mutateAsync: deleteThreadWrite } = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await window.doric.threads.terminate(id);
      await window.doric.threads.delete(id);
    },
  });

  const selectProject = (project: Project): void => {
    intent.current += 1;
    store.selectProject(project);
    void loadThreads(project.id);
  };

  const selectThread = (thread: Thread): void => {
    intent.current += 1;
    store.selectThread(thread);
    if (!isDescribed(tree, thread.projectId))
      void loadThreads(thread.projectId);
  };

  const beginProject = (): void => {
    intent.current += 1;
    store.beginProject();
  };

  const beginThread = (projectId: string, parentThreadId?: string): void => {
    intent.current += 1;
    store.beginThread(projectId, parentThreadId);
    if (!isDescribed(tree, projectId)) void loadThreads(projectId);
  };

  const createProject = async (name: string): Promise<void> => {
    const operationIntent = intent.current;
    const sequence = nextSequence(mutationSequences.current, 'projects:create');
    try {
      const project = await createProjectWrite(name);
      store.applyCreatedProject(project);
      if (
        isCurrentSequence(
          mutationSequences.current,
          'projects:create',
          sequence,
        ) &&
        intent.current === operationIntent
      ) {
        store.select({ projectId: project.id });
        store.clearProjectDraft();
      }
    } catch (reason) {
      store.fail(reason);
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
      store.applyThread(thread);
      if (
        isCurrentSequence(mutationSequences.current, key, sequence) &&
        intent.current === operationIntent
      ) {
        store.select({ projectId: thread.projectId, threadId: thread.id });
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
        const project = await renameProjectWrite({ id: entity.value.id, name });
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
        store.applyProject(project);
      } else {
        invalidateLoads(entity.value.projectId);
        const thread = await renameThreadWrite({ id: entity.value.id, name });
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
        invalidateLoads(thread.projectId);
        store.applyThread(thread);
      }
      if (intent.current === operationIntent) {
        store.clearRename(entity);
      }
    } catch (reason) {
      store.fail(reason);
    }
  };

  const setProjectColor = async (
    project: Project,
    color?: ProjectColor,
  ): Promise<void> => {
    const key = `projects:color:${project.id}`;
    const sequence = nextSequence(mutationSequences.current, key);
    try {
      const updated = await setProjectColorWrite({ id: project.id, color });
      if (!isCurrentSequence(mutationSequences.current, key, sequence)) return;
      store.applyProject(updated);
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
        store.forgetProject(entity.value.id);
      } else {
        invalidateLoads(entity.value.projectId);
        await deleteThreadWrite(entity.value.id);
        if (!isCurrentSequence(mutationSequences.current, key, sequence))
          return;
        store.forgetThread(entity.value.projectId, entity.value.id);
        void loadThreads(entity.value.projectId);
      }
      if (intent.current === operationIntent) store.clearDeleting();
    } catch (reason) {
      store.fail(reason);
    } finally {
      store.settleDelete();
    }
  };

  const actions: WorkspaceActions = {
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
        .catch(() => store.report('Unable to copy the thread ID.'));
    },
    createProject,
    createThread,
    dismissDelete: () => store.dismissDelete(),
    rename,
    requestDelete: (entity) => store.requestDelete(entity),
    selectProject,
    selectThread,
    setProjectColor,
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
