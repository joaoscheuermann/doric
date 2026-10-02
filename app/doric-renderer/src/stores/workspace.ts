import {
  applyUpdate as applyTreeUpdate,
  emptyTree,
  forgetProject as forgetTreeProject,
  forgetThread as forgetTreeThread,
  type ProjectTree,
  type Selection,
  type TreeUpdate,
  withProject,
  withProjects,
  withSelection,
  withThread,
  withThreads,
} from '@/domain/project-tree';
import {
  beginDelete,
  beginProject,
  beginThread,
  cancelDraft,
  cancelRename,
  clearDeleting,
  clearError,
  clearProjectDraft,
  clearRename,
  clearThreadDraft,
  dismissDelete,
  emptySidebar,
  fail,
  report,
  requestDelete,
  selectProject as selectProjectSidebar,
  selectThread as selectThreadSidebar,
  settleDelete,
  type Sidebar,
  startRename,
} from '@/domain/sidebar';
import type { Draft, Entity, Project, Thread } from '@/domain/workspace';
import { createStore } from 'zustand/vanilla';

/**
 * The workspace sidebar's copy of the host's Project tree and its transient
 * state: the dialogs in progress, the one error a failed request surfaces, and
 * how much of the tree is still arriving. Every transition is one of the pure
 * rules in `@/domain/project-tree` or `@/domain/sidebar`; this store only
 * decides which rule a step applies.
 */
export type WorkspaceState = {
  readonly tree: ProjectTree;
  readonly sidebar: Sidebar;
  readonly loadingProjects: boolean;
  readonly loadingProjectThreads: ReadonlySet<string>;

  readonly applyProjects: (projects: readonly Project[]) => void;
  readonly applyProject: (project: Project) => void;
  /** A created Project arrives described, with no Threads yet. */
  readonly applyCreatedProject: (project: Project) => void;
  readonly applyThreads: (
    projectId: string,
    threads: readonly Thread[],
  ) => void;
  readonly applyThread: (thread: Thread) => void;
  readonly applyUpdate: (update: TreeUpdate) => void;
  readonly forgetProject: (projectId: string) => void;
  readonly forgetThread: (projectId: string, threadId: string) => void;
  readonly select: (selection: Selection) => void;
  readonly selectProject: (project: Project) => void;
  readonly selectThread: (thread: Thread) => void;

  readonly beginProject: () => void;
  readonly beginThread: (projectId: string, parentThreadId?: string) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly startRename: (entity: Entity) => void;
  readonly requestDelete: (entity: Entity) => void;
  readonly dismissDelete: () => void;
  readonly beginDelete: () => void;
  readonly settleDelete: () => void;
  readonly clearDeleting: () => void;
  readonly clearProjectDraft: () => void;
  readonly clearThreadDraft: (draft: Draft) => void;
  readonly clearRename: (entity: Entity) => void;
  readonly fail: (reason: unknown) => void;
  readonly report: (message: string) => void;
  readonly clearError: () => void;

  readonly setLoadingProjects: (loading: boolean) => void;
  readonly beginThreadsLoad: (projectId: string) => void;
  readonly endThreadsLoad: (projectId: string) => void;
};

const sidebarState = (sidebar: Sidebar): Pick<WorkspaceState, 'sidebar'> => ({
  sidebar,
});

const treeState = (tree: ProjectTree): Pick<WorkspaceState, 'tree'> => ({
  tree,
});

export const workspaceStore = createStore<WorkspaceState>()((set) => ({
  tree: emptyTree,
  sidebar: emptySidebar,
  loadingProjects: true,
  loadingProjectThreads: new Set<string>(),

  applyProjects: (projects) =>
    set((state) => treeState(withProjects(state.tree, projects))),
  applyProject: (project) =>
    set((state) => treeState(withProject(state.tree, project))),
  applyCreatedProject: (project) =>
    set((state) =>
      treeState(withThreads(withProject(state.tree, project), project.id, [])),
    ),
  applyThreads: (projectId, threads) =>
    set((state) => treeState(withThreads(state.tree, projectId, threads))),
  applyThread: (thread) =>
    set((state) => treeState(withThread(state.tree, thread))),
  applyUpdate: (update) =>
    set((state) => treeState(applyTreeUpdate(state.tree, update))),
  forgetProject: (projectId) =>
    set((state) => treeState(forgetTreeProject(state.tree, projectId))),
  forgetThread: (projectId, threadId) =>
    set((state) =>
      treeState(forgetTreeThread(state.tree, projectId, threadId)),
    ),
  select: (selection) =>
    set((state) => treeState(withSelection(state.tree, selection))),
  selectProject: (project) =>
    set((state) => ({
      ...treeState(withSelection(state.tree, { projectId: project.id })),
      ...sidebarState(selectProjectSidebar(state.sidebar)),
    })),
  selectThread: (thread) =>
    set((state) => ({
      ...treeState(
        withSelection(state.tree, {
          projectId: thread.projectId,
          threadId: thread.id,
        }),
      ),
      ...sidebarState(selectThreadSidebar(state.sidebar)),
    })),

  beginProject: () => set((state) => sidebarState(beginProject(state.sidebar))),
  beginThread: (projectId, parentThreadId) =>
    set((state) => ({
      ...sidebarState(beginThread(state.sidebar, projectId, parentThreadId)),
      ...(state.tree.selection.projectId === projectId
        ? {}
        : treeState(withSelection(state.tree, { projectId }))),
    })),
  cancelDraft: () => set((state) => sidebarState(cancelDraft(state.sidebar))),
  cancelRename: () => set((state) => sidebarState(cancelRename(state.sidebar))),
  startRename: (entity) =>
    set((state) => sidebarState(startRename(state.sidebar, entity))),
  requestDelete: (entity) =>
    set((state) => sidebarState(requestDelete(state.sidebar, entity))),
  dismissDelete: () =>
    set((state) => sidebarState(dismissDelete(state.sidebar))),
  beginDelete: () => set((state) => sidebarState(beginDelete(state.sidebar))),
  settleDelete: () => set((state) => sidebarState(settleDelete(state.sidebar))),
  clearDeleting: () =>
    set((state) => sidebarState(clearDeleting(state.sidebar))),
  clearProjectDraft: () =>
    set((state) => sidebarState(clearProjectDraft(state.sidebar))),
  clearThreadDraft: (draft) =>
    set((state) => sidebarState(clearThreadDraft(state.sidebar, draft))),
  clearRename: (entity) =>
    set((state) => sidebarState(clearRename(state.sidebar, entity))),
  fail: (reason) => set((state) => sidebarState(fail(state.sidebar, reason))),
  report: (message) =>
    set((state) => sidebarState(report(state.sidebar, message))),
  clearError: () => set((state) => sidebarState(clearError(state.sidebar))),

  setLoadingProjects: (loading) => set(() => ({ loadingProjects: loading })),
  beginThreadsLoad: (projectId) =>
    set((state) => ({
      loadingProjectThreads: new Set([
        ...state.loadingProjectThreads,
        projectId,
      ]),
    })),
  endThreadsLoad: (projectId) =>
    set((state) => {
      const next = new Set(state.loadingProjectThreads);
      next.delete(projectId);
      return { loadingProjectThreads: next };
    }),
}));
