import type { Disposable } from 'bundle/contracts';
import { ClientError, type ErrorInfo, errorInfo } from 'desktop/reads';
import { createStore } from 'zustand/vanilla';

import {
  emptyTree,
  type ProjectTree,
  type Selection,
  withRecords,
  withSelection,
} from '../domain/project-tree.js';
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
  type Sidebar,
  selectProject as selectProjectSidebar,
  selectThread as selectThreadSidebar,
  settle,
  settleDelete,
  startRename,
  type WorkspaceRetry,
} from '../domain/sidebar.js';
import type {
  Draft,
  Entity,
  Project,
  RecordsRead,
  RuntimeRecords,
  Thread,
} from '../domain/workspace.js';

/**
 * The workspace sidebar's copy of the host's Project tree and its transient
 * state: the dialogs in progress, the one error a failed request surfaces, and
 * how much of the tree is still arriving. The tree's records are a projection
 * of `runtime.records/v1` (bundle isolation phase 3), rebuilt by `sync`; every
 * other transition is one of the pure rules in `@/domain/project-tree` or
 * `@/domain/sidebar`.
 */
export type WorkspaceState = {
  readonly tree: ProjectTree;
  readonly sidebar: Sidebar;
  readonly loadingProjects: boolean;
  readonly loadingProjectThreads: ReadonlySet<string>;

  /** The Projects whose Threads the layout reads from the mirror (R5). */
  readonly requested: ReadonlySet<string>;
  /**
   * Adds `projectId` to `requested` and syncs with the bound mirror, which
   * reads its Threads and so starts their first load.
   */
  readonly request: (projectId: string) => void;
  /**
   * Rebuilds the tree's records from `records`: its Projects and the Threads
   * of every requested Project it describes (`withRecords`). Answers the same
   * state when nothing changed. A `project_stream_failed` read of the selected
   * Project is reported once. Without a mirror the tree stays.
   */
  readonly sync: (records: RuntimeRecords | undefined) => void;
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
  /**
   * Stores `reason`, read as `errorInfo(reason)`, as the one error, with
   * `retry` as its target (absent: no target); replaces any earlier error.
   * Never throws, whatever `reason` is.
   */
  readonly fail: (reason: unknown, retry?: WorkspaceRetry) => void;
  /** Stores `error` as the one error, with no retry target. */
  readonly report: (error: ErrorInfo) => void;
  /**
   * A load of `target` succeeded: clears the error when its retry target is
   * the same target; any other error stays.
   */
  readonly settle: (target: WorkspaceRetry) => void;
  readonly clearError: () => void;

  readonly setLoadingProjects: (loading: boolean) => void;
  readonly beginThreadsLoad: (projectId: string) => void;
  readonly endThreadsLoad: (projectId: string) => void;
};

const sidebarState = (sidebar: Sidebar): Pick<WorkspaceState, 'sidebar'> => ({
  sidebar,
});

/** The mirror `bindRecords` bound, if any. */
let bound: RuntimeRecords | undefined;
let boundSubscription: Disposable | undefined;
/** The stream failure `sync` reported last, so it is reported once. */
let reportedFailure: unknown;

const treeState = (tree: ProjectTree): Pick<WorkspaceState, 'tree'> => ({
  tree,
});

export const workspaceStore = createStore<WorkspaceState>()((set, get) => ({
  tree: emptyTree,
  sidebar: emptySidebar,
  loadingProjects: true,
  loadingProjectThreads: new Set<string>(),

  requested: new Set<string>(),

  request: (projectId) => {
    const state = get();
    if (!state.requested.has(projectId)) {
      set({ requested: new Set([...state.requested, projectId]) });
    }
    get().sync(bound);
  },
  sync: (records) => {
    // The reads are made before the state is set: a first read starts a load,
    // and the mirror may answer it with a notice of its own.
    const state = get();
    if (records === undefined) return;
    const projectsRead = records.projects();
    const projects = projectsRead.value ?? [];
    const listed =
      projectsRead.status === 'ready'
        ? new Set(projects.map((project) => project.id))
        : undefined;
    const threadsByProject: Record<string, readonly Thread[]> = {};
    let streamFailure: RecordsRead<unknown> | undefined;
    for (const projectId of state.requested) {
      // A Project the loaded list no longer holds is not read again.
      if (listed !== undefined && !listed.has(projectId)) continue;
      const read = records.threads(projectId);
      if (read.value !== undefined) threadsByProject[projectId] = read.value;
      if (
        projectId === state.tree.selection.projectId &&
        read.status === 'failed' &&
        read.error.code === 'project_stream_failed'
      )
        streamFailure = read;
    }
    const current = get();
    const tree = withRecords(current.tree, { projects, threadsByProject });
    const failure =
      streamFailure?.status === 'failed' &&
      streamFailure.error !== reportedFailure
        ? streamFailure.error
        : undefined;
    if (failure !== undefined) reportedFailure = failure;
    if (tree === current.tree && failure === undefined) return;
    set({
      tree,
      ...(failure === undefined
        ? {}
        : sidebarState(report(current.sidebar, errorInfo(failure)))),
    });
  },
  select: (selection) =>
    set((state) => {
      const tree = withSelection(state.tree, selection);
      return tree === state.tree ? state : treeState(tree);
    }),
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
  fail: (reason, retry) =>
    set((state) => sidebarState(fail(state.sidebar, errorInfo(reason), retry))),
  report: (error) => set((state) => sidebarState(report(state.sidebar, error))),
  settle: (target) =>
    set((state) => sidebarState(settle(state.sidebar, target))),
  clearError: () => set((state) => sidebarState(clearError(state.sidebar))),

  setLoadingProjects: (loading) => set(() => ({ loadingProjects: loading })),
  // A load that changes nothing keeps the set and notifies no one: ending a
  // load is also how a write discards loads that may not be running.
  beginThreadsLoad: (projectId) =>
    set((state) =>
      state.loadingProjectThreads.has(projectId)
        ? state
        : {
            loadingProjectThreads: new Set([
              ...state.loadingProjectThreads,
              projectId,
            ]),
          },
    ),
  endThreadsLoad: (projectId) =>
    set((state) => {
      if (!state.loadingProjectThreads.has(projectId)) return state;
      const next = new Set(state.loadingProjectThreads);
      next.delete(projectId);
      return { loadingProjectThreads: next };
    }),
}));

/**
 * Binds the workspace to `records`, the window's `runtime.records/v1`: the
 * store syncs at once and on every notice of the mirror. `undefined` unbinds
 * it.
 */
export const bindRecords = (records: RuntimeRecords | undefined): void => {
  boundSubscription?.dispose();
  boundSubscription = undefined;
  bound = records;
  if (records !== undefined) {
    boundSubscription = records.subscribe(() =>
      workspaceStore.getState().sync(records),
    );
  }
  workspaceStore.getState().sync(records);
};

/** The mirror `bindRecords` bound; read it anew at each call. */
export const boundRecords = (): RuntimeRecords | undefined => bound;

/** The failure a read answers when no mirror is bound. */
const unavailable = (): ClientError =>
  new ClientError('unavailable', 'Doric backend is unavailable.');

/**
 * Calls reload(target) and resolves with the read's first state that is not
 * `loading`. With no mirror bound, the state is `failed` with
 * ClientError('unavailable', …).
 */
export const awaitRead = (
  target:
    | { readonly target: 'projects' }
    | { readonly target: 'threads'; readonly projectId: string },
): Promise<RecordsRead<readonly unknown[]>> => {
  const records = bound;
  if (records === undefined) {
    return Promise.resolve({ status: 'failed', error: unavailable() });
  }
  const read = (): RecordsRead<readonly unknown[]> =>
    target.target === 'projects'
      ? records.projects()
      : records.threads(target.projectId);
  return new Promise((resolve) => {
    let subscription: Disposable | undefined;
    let settled = false;
    const check = () => {
      if (settled) return;
      const answer = read();
      if (answer.status === 'loading') return;
      settled = true;
      subscription?.dispose();
      resolve(answer);
    };
    subscription = records.subscribe(check);
    records.reload(target);
    check();
  });
};
