import {
  applyUpdate,
  type Cascade,
  emptyTree,
  forgetProject,
  forgetTabs,
  forgetThread,
  isDescribed,
  type ProjectTree,
  replaceTab,
  type Selection,
  threadsOf,
  withProject,
  withProjects,
  withSelection,
  withThread,
  withThreads,
} from '@/domain/project-tree';
import {
  type Draft,
  type Entity,
  messageFrom,
  moveThreadTab,
  openThreadTab,
  type Project,
  type Thread,
} from '@/domain/workspace';
import { useEffect, useRef, useState } from 'react';

import { usePersistedTabs } from './use-persisted-tabs';
import { useProjectEvents } from './use-project-events';

export type WorkspaceActions = {
  readonly beginProject: () => void;
  readonly beginThread: (projectId: string, parentThreadId?: string) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly closeThread: (id: string) => void;
  readonly confirmDelete: () => Promise<void>;
  readonly copyThreadId: (id: string) => void;
  readonly createProject: (name: string) => Promise<void>;
  readonly createThread: (name: string) => Promise<void>;
  readonly dismissDelete: () => void;
  readonly moveThread: (
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => void;
  readonly rename: (entity: Entity, name: string) => Promise<void>;
  readonly requestDelete: (entity: Entity) => void;
  readonly selectProject: (project: Project) => void;
  readonly selectThread: (thread: Thread) => void;
  readonly startRename: (entity: Entity) => void;
};

/**
 * Everything the workspace page shows and everything the user can ask it to do:
 * the Projects and Threads it knows, the open tabs, the dialogs in progress, and
 * the one error a failed request surfaces. The rules behind these transitions
 * are pure and live in `@/domain/project-tree`.
 */
export type Workspace = {
  readonly actions: WorkspaceActions;
  readonly deleting?: Entity;
  readonly deletingPending: boolean;
  readonly draft?: Draft;
  readonly editing?: Entity;
  readonly error?: string;
  readonly loadingProjects: boolean;
  readonly loadingThreads: boolean;
  readonly openThreads: readonly Thread[];
  readonly projects: readonly Project[];
  readonly selectedProjectId?: string;
  readonly selectedThread?: Thread;
  readonly selectedThreadId?: string;
  readonly threads: readonly Thread[];
};

export const useWorkspace = (): Workspace => {
  const [tree, setTree] = useState<ProjectTree>(emptyTree);
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState<Entity>();
  const [deleting, setDeleting] = useState<Entity>();
  const [deletingPending, setDeletingPending] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingProjectThreads, setLoadingProjectThreads] = useState<
    ReadonlySet<string>
  >(new Set());
  const [error, setError] = useState<string>();
  /** Interaction intent, so work started before the last one cannot land after it. */
  const intent = useRef(0);
  /** Interaction intent at mount, so a late tab restore cannot win. */
  const restoreIntent = useRef(intent.current);
  const loadSequences = useRef(new Map<string, number>());
  const mutationSequences = useRef(new Map<string, number>());

  const select = (selection: Selection): void =>
    setTree((current) => withSelection(current, selection));

  const nextMutation = (key: string): number => {
    const sequence = (mutationSequences.current.get(key) ?? 0) + 1;
    mutationSequences.current.set(key, sequence);
    return sequence;
  };

  const mutationIsCurrent = (key: string, sequence: number): boolean =>
    mutationSequences.current.get(key) === sequence;

  /**
   * The one way a failed request reaches the user. Node reports a rejected IPC
   * call as an `Error`, and anything else becomes the fallback message.
   */
  const failed = (reason: unknown): void => setError(messageFrom(reason));

  /** Discards loads already in flight for a Project whose Threads just changed. */
  const invalidateLoads = (projectId: string): void => {
    loadSequences.current.set(
      projectId,
      (loadSequences.current.get(projectId) ?? 0) + 1,
    );
    setLoadingProjectThreads((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  };

  const loadThreads = async (projectId: string): Promise<void> => {
    const requestIntent = intent.current;
    const sequence = (loadSequences.current.get(projectId) ?? 0) + 1;
    loadSequences.current.set(projectId, sequence);
    setLoadingProjectThreads((current) => new Set([...current, projectId]));
    try {
      const threads = await window.doric.threads.list(projectId);
      if (loadSequences.current.get(projectId) !== sequence) return;
      setTree((current) => withThreads(current, projectId, threads));
    } catch (reason) {
      if (
        loadSequences.current.get(projectId) === sequence &&
        intent.current === requestIntent
      ) {
        failed(reason);
      }
    } finally {
      if (loadSequences.current.get(projectId) === sequence) {
        setLoadingProjectThreads((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    let active = true;
    const initialIntent = intent.current;
    void window.doric.projects
      .list()
      .then((projects) => {
        if (!active) return;
        setTree((current) => withProjects(current, projects));
        const first = projects[0];
        if (first && intent.current === initialIntent) {
          select({ projectId: first.id });
          void loadThreads(first.id);
        }
      })
      .catch((reason: unknown) => {
        if (active && intent.current === initialIntent) {
          failed(reason);
        }
      })
      .finally(() => {
        if (active) setLoadingProjects(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const { openThreads, setOpenThreads, setSelectedThreadId } = usePersistedTabs(
    {
      isCurrent: () => intent.current === restoreIntent.current,
      onRestore: (thread) => {
        intent.current += 1;
        select({ projectId: thread.projectId, threadId: thread.id });
        void loadThreads(thread.projectId);
      },
      get: (id) => window.doric.threads.get(id),
    },
  );

  /**
   * The tree owns the selection; the tab store keeps the copy it persists.
   * Every selection change flows through here, so the persisted copy cannot
   * drift from the one the surfaces render.
   */
  useEffect(() => {
    setSelectedThreadId(tree.selection.threadId);
  }, [tree.selection.threadId, setSelectedThreadId]);

  /**
   * Forgets whatever a cascade took out of the tree and closes the tabs that
   * followed it. The tree advances from its latest value so back-to-back
   * updates are all kept, while the removal settles the tabs.
   */
  const forget = (cascade: (tree: ProjectTree) => Cascade): void => {
    const { removal } = cascade(tree);
    if (removal !== undefined) {
      setOpenThreads((tabs) => forgetTabs(tabs, removal));
    }
    setTree((current) => cascade(current).tree);
  };

  useProjectEvents({
    projectId: tree.selection.projectId,
    onUpdate: (update) => {
      if (update.kind === 'thread-updated') {
        setOpenThreads((tabs) => replaceTab(tabs, update.thread));
      }
      forget((current) => applyUpdate(current, update));
    },
    onError: setError,
  });

  const selectProject = (project: Project): void => {
    intent.current += 1;
    setError(undefined);
    setDraft(undefined);
    setEditing(undefined);
    select({ projectId: project.id });
    void loadThreads(project.id);
  };

  const selectThread = (thread: Thread): void => {
    intent.current += 1;
    setDraft(undefined);
    setEditing(undefined);
    select({ projectId: thread.projectId, threadId: thread.id });
    setOpenThreads((current) => openThreadTab(current, thread));
    if (!isDescribed(tree, thread.projectId))
      void loadThreads(thread.projectId);
  };

  const beginProject = (): void => {
    intent.current += 1;
    setError(undefined);
    setEditing(undefined);
    setDraft({ kind: 'project' });
  };

  const beginThread = (projectId: string, parentThreadId?: string): void => {
    intent.current += 1;
    setError(undefined);
    setEditing(undefined);
    setDraft({ kind: 'thread', projectId, parentThreadId });
    if (tree.selection.projectId !== projectId) select({ projectId });
    if (!isDescribed(tree, projectId)) void loadThreads(projectId);
  };

  const createProject = async (name: string): Promise<void> => {
    const operationIntent = intent.current;
    const sequence = nextMutation('projects:create');
    try {
      const project = await window.doric.projects.create(name);
      setTree((current) =>
        withThreads(withProject(current, project), project.id, []),
      );
      if (
        mutationIsCurrent('projects:create', sequence) &&
        intent.current === operationIntent
      ) {
        select({ projectId: project.id });
        setDraft((current) =>
          current?.kind === 'project' ? undefined : current,
        );
      }
    } catch (reason) {
      failed(reason);
    }
  };

  const createThread = async (name: string): Promise<void> => {
    if (draft?.kind !== 'thread') return;
    const operationDraft = draft;
    const operationIntent = intent.current;
    const key = `threads:create:${operationDraft.projectId}`;
    const sequence = nextMutation(key);
    invalidateLoads(operationDraft.projectId);
    try {
      const thread = await window.doric.threads.create(
        operationDraft.projectId,
        name,
        operationDraft.parentThreadId,
      );
      invalidateLoads(thread.projectId);
      setTree((current) => withThread(current, thread));
      if (
        mutationIsCurrent(key, sequence) &&
        intent.current === operationIntent
      ) {
        select({ projectId: thread.projectId, threadId: thread.id });
        setOpenThreads((current) => openThreadTab(current, thread));
        setDraft((current) =>
          current === operationDraft ? undefined : current,
        );
      }
    } catch (reason) {
      failed(reason);
    }
  };

  const rename = async (entity: Entity, name: string): Promise<void> => {
    const key = `${entity.kind}:rename:${entity.value.id}`;
    const sequence = nextMutation(key);
    const operationIntent = intent.current;
    try {
      if (entity.kind === 'project') {
        const project = await window.doric.projects.rename(
          entity.value.id,
          name,
        );
        if (!mutationIsCurrent(key, sequence)) return;
        setTree((current) => withProject(current, project));
      } else {
        invalidateLoads(entity.value.projectId);
        const thread = await window.doric.threads.rename(entity.value.id, name);
        if (!mutationIsCurrent(key, sequence)) return;
        invalidateLoads(thread.projectId);
        setTree((current) => withThread(current, thread));
        setOpenThreads((current) => replaceTab(current, thread));
      }
      if (intent.current === operationIntent) {
        setEditing((current) =>
          current?.kind === entity.kind && current.value.id === entity.value.id
            ? undefined
            : current,
        );
      }
    } catch (reason) {
      failed(reason);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === undefined) return;
    const entity = deleting;
    const operationIntent = intent.current;
    const key = `${entity.kind}:delete:${entity.value.id}`;
    const sequence = nextMutation(key);
    setDeletingPending(true);
    setError(undefined);
    try {
      if (entity.kind === 'project') {
        invalidateLoads(entity.value.id);
        await window.doric.projects.terminate(entity.value.id);
        await window.doric.projects.delete(entity.value.id);
        if (!mutationIsCurrent(key, sequence)) return;
        forget((current) => forgetProject(current, entity.value.id));
      } else {
        invalidateLoads(entity.value.projectId);
        await window.doric.threads.terminate(entity.value.id);
        await window.doric.threads.delete(entity.value.id);
        if (!mutationIsCurrent(key, sequence)) return;
        forget((current) =>
          forgetThread(current, entity.value.projectId, entity.value.id),
        );
        void loadThreads(entity.value.projectId);
      }
      if (intent.current === operationIntent) setDeleting(undefined);
    } catch (reason) {
      failed(reason);
    } finally {
      setDeletingPending(false);
    }
  };

  const closeThread = (id: string): void => {
    const index = openThreads.findIndex((thread) => thread.id === id);
    if (index === -1) return;
    const remaining = openThreads.filter((thread) => thread.id !== id);
    setOpenThreads(remaining);
    if (tree.selection.threadId !== id) return;

    const replacement = remaining[Math.min(index, remaining.length - 1)];
    if (replacement) {
      selectThread(replacement);
      return;
    }
    intent.current += 1;
    setDraft(undefined);
    setEditing(undefined);
    select({ projectId: tree.selection.projectId });
  };

  const actions: WorkspaceActions = {
    beginProject,
    beginThread,
    cancelDraft: () => {
      intent.current += 1;
      setDraft(undefined);
    },
    cancelRename: () => {
      intent.current += 1;
      setEditing(undefined);
    },
    closeThread,
    confirmDelete,
    copyThreadId: (id) => {
      setError(undefined);
      void navigator.clipboard
        .writeText(id)
        .catch(() => setError('Unable to copy the thread ID.'));
    },
    createProject,
    createThread,
    dismissDelete: () => {
      if (!deletingPending) setDeleting(undefined);
    },
    moveThread: (sourceId, targetId, position) => {
      setOpenThreads((current) =>
        moveThreadTab(current, sourceId, targetId, position),
      );
    },
    rename,
    requestDelete: setDeleting,
    selectProject,
    selectThread,
    startRename: (entity) => {
      intent.current += 1;
      setDraft(undefined);
      setEditing(entity);
    },
  };

  const selectedProjectId = tree.selection.projectId;
  const selectedThreadId = tree.selection.threadId;

  return {
    actions,
    deleting,
    deletingPending,
    draft,
    editing,
    error,
    loadingProjects,
    loadingThreads:
      selectedProjectId !== undefined &&
      loadingProjectThreads.has(selectedProjectId),
    openThreads,
    projects: tree.projects,
    selectedProjectId,
    selectedThread: openThreads.find(
      (thread) => thread.id === selectedThreadId,
    ),
    selectedThreadId,
    threads: threadsOf(tree, selectedProjectId),
  };
};
