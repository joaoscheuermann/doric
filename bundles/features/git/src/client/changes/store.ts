// git.changes/v1 (stage 10, §3.8): the git bundle's one query client in the
// window and its changes read, moved from the changes part of the layout's
// `useProjectFiles`, plus the Changes view's collapsed directories (the
// layout's `filesStore.changesCollapsed`). The changes query keeps its key,
// `['files', p, 'changes', cwd]`; the Project's Thread summaries live in this
// client too, and both are reread together for a Project. Each retries a failed
// read a bounded number of times and polls a pending lease at the host's hint.
// It runs only while something observes it [D10-14].

import type { Query } from '@tanstack/query-core';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { type Disposable, defineMethod, defineService } from 'bundle/contracts';
import {
  messageFrom,
  pendingReadInterval,
  readRetry,
  refreshQueries,
} from 'desktop/reads';
import { toggleExpanded } from 'desktop/ui/panels';
import { type ReadState, ROOT_PATH, workspacePath } from 'files/contracts';
import { createStore } from 'zustand/vanilla';

import {
  type ChangesObservation,
  type ChangesScope,
  GitChangesV1,
  gitChangesMethods,
  type ProjectChanges,
  type ProjectChangesResult,
} from '../../contracts/index.js';
import type { GitApi } from '../api/git-api.js';
import { changeMarks } from '../reads/change-tree.js';

/**
 * The host is local and answers once, so nothing refetches on its own: a read
 * happens when a surface asks for it and a reload when something invalidates
 * it (the layout's `createQueryClient`).
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      },
      mutations: { retry: false },
    },
  });

/** Every key the git bundle caches under, as the layout's `queryKeys` named them. */
export const gitKeys = {
  changes: (projectId: string, cwd: string | undefined) => [
    'files',
    projectId,
    'changes',
    cwd,
  ],
  fileDiff: (projectId: string, repository: string, path: string) => [
    'files',
    projectId,
    'file-diff',
    repository,
    path,
  ],
  threadGit: (threadId: string | undefined, cwd?: string) =>
    cwd === undefined
      ? ['thread', threadId, 'git']
      : ['thread', threadId, 'git', cwd],
  branches: (threadId: string, cwd: string) => [
    'thread',
    threadId,
    'git',
    cwd,
    'branches',
  ],
  credentials: ['credentials'],
};

/** The workspace-relative root a working directory names. */
export const rootOf = (cwd: string | undefined): string =>
  cwd === undefined ? ROOT_PATH : workspacePath(cwd);

/**
 * The queries a refresh of one Project rereads in this client: its changes and
 * file comparisons, and each Thread's Git summary that carries the Project.
 */
const projectGitQueries =
  (projectId: string) =>
  (query: Query): boolean =>
    (query.queryKey[0] === 'files' && query.queryKey[1] === projectId) ||
    (query.queryKey[0] === 'thread' &&
      query.meta?.projectId === projectId &&
      query.queryKey[2] === 'git');

/**
 * What the Changes view and the footer read: idle until asked, `loading`
 * until the first answer, the changes, or why there are none. A failed read
 * with no earlier answer is idle (its toast says why).
 */
export const changesReadState = (
  data: ProjectChangesResult | undefined,
  pending: boolean,
): ReadState<ProjectChanges> =>
  data?.status === 'ready'
    ? { status: 'ready', value: data.changes }
    : (data ?? { status: pending ? 'loading' : 'idle' });

/** The Changes view's collapsed directories, per Project and root. */
type CollapsedState = {
  readonly views: Readonly<Record<string, ReadonlySet<string>>>;
  readonly toggle: (scope: string, key: string) => void;
};

const emptyCollapsed: ReadonlySet<string> = new Set<string>();

export const createCollapsedStore = () =>
  createStore<CollapsedState>()((set) => ({
    views: {},
    toggle: (scope, key) =>
      set((state) => ({
        views: {
          ...state.views,
          [scope]: toggleExpanded(state.views[scope] ?? emptyCollapsed, key),
        },
      })),
  }));

export type CollapsedStore = ReturnType<typeof createCollapsedStore>;

/** The collapsed set of one scope, never undefined. */
export const collapsedOf = (
  state: CollapsedState,
  scope: string,
): ReadonlySet<string> => state.views[scope] ?? emptyCollapsed;

/** The key the Changes view's state is kept under: one Project and root. */
export const collapsedScope = (projectId: string, root: string): string =>
  JSON.stringify([projectId, root]);

export interface GitStore {
  readonly client: QueryClient;
  readonly api: () => GitApi;
  readonly collapsed: CollapsedStore;
  observeChanges(
    scope: ChangesScope,
    listener: (state: ChangesObservation) => void,
  ): Disposable;
  /** Rereads the Project's active reads in this client. */
  refresh(projectId: string, periodic: boolean): Promise<void>;
  dispose(): void;
}

export const createGitStore = (
  api: () => GitApi,
  client: QueryClient = createQueryClient(),
): GitStore => ({
  client,
  api,
  collapsed: createCollapsedStore(),
  observeChanges: ({ projectId, cwd }, listener) => {
    const root = rootOf(cwd);
    const observer = new QueryObserver<ProjectChangesResult, Error>(client, {
      queryKey: gitKeys.changes(projectId, cwd),
      queryFn: () =>
        api().changes(projectId, root === ROOT_PATH ? undefined : root),
      ...readRetry,
      refetchInterval: (query) =>
        query.state.status === 'error'
          ? false
          : pendingReadInterval(query.state.data),
    });
    // The read and its marks are derived once per answer: a refresh that
    // answers the same changes keeps both, and a notification that changes
    // nothing the observation carries (a retry count, a timestamp) is not sent.
    let last:
      | {
          readonly data: ProjectChangesResult | undefined;
          readonly pending: boolean;
          readonly observation: ChangesObservation;
        }
      | undefined;
    const emit = () => {
      const result = observer.getCurrentResult();
      const error = result.isError ? messageFrom(result.error) : undefined;
      const kept =
        last !== undefined &&
        last.data === result.data &&
        last.pending === result.isPending
          ? last.observation
          : undefined;
      if (
        kept !== undefined &&
        kept.error === error &&
        kept.fetching === result.isFetching
      )
        return;
      const read =
        kept?.read ?? changesReadState(result.data, result.isPending);
      const observation: ChangesObservation = {
        read,
        decorations:
          kept?.decorations ??
          (read.status === 'ready'
            ? changeMarks(read.value.repositories)
            : new Map()),
        ...(error === undefined ? {} : { error }),
        fetching: result.isFetching,
      };
      last = { data: result.data, pending: result.isPending, observation };
      listener(observation);
    };
    const stop = observer.subscribe(emit);
    emit();
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        stop();
        observer.destroy();
      },
    };
  },
  refresh: (projectId, periodic) =>
    refreshQueries(client, projectId, projectGitQueries(projectId), periodic),
  dispose: () => client.clear(),
});

/** `git.changes/v1` over a store. */
export const createGitChanges = (store: GitStore) =>
  defineService(GitChangesV1, {
    observe: defineMethod({
      ...gitChangesMethods.observe,
      execute: ([scope, listener]: [
        ChangesScope,
        (state: ChangesObservation) => void,
      ]) => store.observeChanges(scope, listener),
    }),
  });
