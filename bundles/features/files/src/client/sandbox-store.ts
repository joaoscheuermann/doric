// files.sandbox/v1 (stage 10, §3.6): the window's query client of the files
// bundle and its tree read, moved from the tree part of the layout's
// `useProjectFiles`. The tree query keeps its key, `['files', p, 'tree', cwd]`,
// so the Project's `['files', p, …]` targeting is unchanged; it retries a
// failed read a bounded number of times and polls a pending lease at the
// host's hint. It is enabled only while something observes it.
//
// The tree is read per directory (`files/v1.directories`): the query reads the
// root and the directories open in it (the expansion store) in one call, so a
// refresh rereads what is shown and nothing else. A directory opened later is
// read on its own and merged into the query, showing as loading meanwhile;
// one whose read fails closes again and the failure is the observation's
// error, which the panel's read toast shows.

import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { type Disposable, defineMethod, defineService } from 'bundle/contracts';
import {
  messageFrom,
  pendingReadInterval,
  readRetry,
  refreshQueries,
} from 'desktop/reads';

import {
  FilesSandboxV1,
  filesSandboxMethods,
  ROOT_PATH,
  sandboxNotice,
  type TreeObservation,
  type TreeScope,
  workspacePath,
} from '../contracts/index.js';
import type { FilesReads } from './api/reads.js';
import {
  assembleTree,
  openDirectories,
  unreadDirectories,
} from './reads/directory-tree.js';
import type {
  DirectoryListing,
  ProjectDirectoriesResult,
} from './reads/project-files.js';
import { treeReadState } from './reads/state.js';
import {
  emptyExpansion,
  expansionScope,
  expansionStore,
} from './stores/expansion.js';

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

/** Every key the files bundle caches under. */
export const filesKeys = {
  tree: (projectId: string, cwd: string | undefined) => [
    'files',
    projectId,
    'tree',
    cwd,
  ],
  file: (projectId: string, path: string) => ['files', projectId, 'file', path],
};

/** The workspace-relative root a working directory names. */
export const rootOf = (cwd: string | undefined): string =>
  cwd === undefined ? ROOT_PATH : workspacePath(cwd);

/**
 * Rereads a Project's sandbox reads in one client: the tree and every file read
 * of that Project. The Project's Git reads belong to the git bundle, which
 * rereads them through its own client.
 */
export const refreshSandbox = (
  client: QueryClient,
  projectId: string,
  periodic: boolean,
): Promise<void> =>
  refreshQueries(
    client,
    projectId,
    (query) => query.queryKey[0] === 'files' && query.queryKey[1] === projectId,
    periodic,
  );

export interface SandboxStore {
  readonly client: QueryClient;
  observeTree(
    scope: TreeScope,
    listener: (state: TreeObservation) => void,
  ): Disposable;
  /** Rereads the Project's active reads in this client. */
  refresh(projectId: string, periodic: boolean): Promise<void>;
  dispose(): void;
}

/** The directories of one tree being read on their own, shared by its observers. */
interface TreeLoads {
  loading: ReadonlySet<string>;
  /** Why the last directory read failed, until a read succeeds. */
  error?: string;
  readonly listeners: Set<() => void>;
}

const noDirectories: ReadonlySet<string> = new Set<string>();

const sameMembers = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean =>
  left.size === right.size && [...left].every((path) => right.has(path));

export const createSandboxStore = (
  reads: () => FilesReads,
  client: QueryClient = createQueryClient(),
): SandboxStore => {
  const trees = new Map<string, TreeLoads>();
  const loadsOf = (key: readonly unknown[]): TreeLoads => {
    const id = JSON.stringify(key);
    let loads = trees.get(id);
    if (loads === undefined) {
      loads = { loading: noDirectories, listeners: new Set() };
      trees.set(id, loads);
    }
    return loads;
  };
  const changed = (loads: TreeLoads): void => {
    for (const listener of [...loads.listeners]) listener();
  };

  /** The root and the open directories, read in one call. */
  const readTree = async (
    projectId: string,
    root: string,
    key: readonly unknown[],
    scope: string,
  ): Promise<ProjectDirectoriesResult> => {
    const before = client.getQueryData<ProjectDirectoriesResult>(key);
    const listings = before?.status === 'ready' ? before.directories : {};
    const expanded = expansionStore.getState().views[scope] ?? emptyExpansion;
    const result = await reads().directories(
      projectId,
      [root, ...openDirectories(root, expanded, listings)],
      root,
    );
    if (result.status !== 'ready') return result;
    const top = result.directories[root];
    // A root that is gone is the read's answer, as the whole-tree read's was.
    if (top?.status !== 'listed')
      return top?.status === 'not_found'
        ? { status: 'not_found' }
        : { status: 'invalid_path' };
    const loads = loadsOf(key);
    if (loads.error !== undefined) {
      loads.error = undefined;
      changed(loads);
    }
    return result;
  };

  /**
   * Reads the open directories no read has listed yet, in one call, unless the
   * tree query is reading (its read covers what was open when it started; the
   * rest is read once it settles).
   */
  const loadOpened = (
    projectId: string,
    root: string,
    key: readonly unknown[],
    scope: string,
  ): void => {
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    const data = query?.state.data as ProjectDirectoriesResult | undefined;
    if (data?.status !== 'ready' || query?.state.fetchStatus === 'fetching')
      return;
    const loads = loadsOf(key);
    const expanded = expansionStore.getState().views[scope] ?? emptyExpansion;
    const unread = unreadDirectories(root, expanded, data.directories).filter(
      (path) => !loads.loading.has(path),
    );
    if (unread.length === 0) return;
    loads.loading = new Set([...loads.loading, ...unread]);
    changed(loads);
    const fail = (message: string): void => {
      loads.error = message;
      expansionStore.getState().collapse(scope, unread);
    };
    void reads()
      .directories(projectId, unread, root)
      .then(
        (result) => {
          if (result.status !== 'ready') {
            fail(
              sandboxNotice(
                result.status,
                'retryAfterSeconds' in result
                  ? result.retryAfterSeconds
                  : undefined,
              ),
            );
            return;
          }
          const read: Record<string, DirectoryListing> = {};
          for (const path of unread) {
            const listing = result.directories[path];
            if (listing !== undefined) read[path] = listing;
          }
          loads.error = undefined;
          client.setQueryData<ProjectDirectoriesResult>(key, (old) =>
            old?.status === 'ready'
              ? { ...old, directories: { ...old.directories, ...read } }
              : old,
          );
          // A directory gone since its parent was read: reread the parent.
          if (Object.values(read).some((entry) => entry.status !== 'listed'))
            void client
              .refetchQueries(
                { queryKey: key, exact: true, type: 'active' },
                { cancelRefetch: false },
              )
              .catch(() => undefined);
        },
        (error: unknown) => fail(messageFrom(error)),
      )
      .finally(() => {
        loads.loading = new Set(
          [...loads.loading].filter((path) => !unread.includes(path)),
        );
        changed(loads);
      });
  };

  return {
    client,
    observeTree: ({ projectId, cwd }, listener) => {
      const root = rootOf(cwd);
      const key = filesKeys.tree(projectId, cwd);
      const scope = expansionScope(projectId, root);
      const loads = loadsOf(key);
      const observer = new QueryObserver<ProjectDirectoriesResult, Error>(
        client,
        {
          queryKey: key,
          queryFn: () => readTree(projectId, root, key, scope),
          ...readRetry,
          refetchInterval: (query) =>
            query.state.status === 'error'
              ? false
              : pendingReadInterval(query.state.data),
        },
      );
      // An unchanged answer keeps its read, and a notification that changes
      // nothing the observation carries (a retry count, a timestamp) is not
      // sent.
      let last:
        | {
            readonly data: ProjectDirectoriesResult | undefined;
            readonly failed: boolean;
            readonly observation: TreeObservation;
          }
        | undefined;
      const emit = () => {
        const result = observer.getCurrentResult();
        const error = result.isError ? messageFrom(result.error) : loads.error;
        // The open directories not listed yet are loading while a read that
        // covers them is on its way.
        const listings =
          result.data?.status === 'ready' ? result.data.directories : {};
        const loading = result.isFetching
          ? new Set([
              ...loads.loading,
              ...unreadDirectories(
                root,
                expansionStore.getState().views[scope] ?? emptyExpansion,
                listings,
              ),
            ])
          : loads.loading;
        const kept =
          last !== undefined &&
          last.data === result.data &&
          last.failed === result.isError
            ? last.observation
            : undefined;
        if (
          kept !== undefined &&
          kept.error === error &&
          kept.fetching === result.isFetching &&
          sameMembers(kept.loading ?? noDirectories, loading)
        )
          return;
        const observation: TreeObservation = {
          read:
            kept?.read ??
            treeReadState(assembleTree(result.data, root), result.isError),
          ...(error === undefined ? {} : { error }),
          fetching: result.isFetching,
          loading:
            last !== undefined &&
            sameMembers(last.observation.loading ?? noDirectories, loading)
              ? (last.observation.loading ?? noDirectories)
              : loading,
        };
        last = { data: result.data, failed: result.isError, observation };
        listener(observation);
      };
      const update = () => {
        emit();
        loadOpened(projectId, root, key, scope);
      };
      loads.listeners.add(emit);
      const stopQuery = observer.subscribe(update);
      const stopExpansion = expansionStore.subscribe((state, previous) => {
        if (state.views[scope] !== previous.views[scope]) update();
      });
      update();
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          loads.listeners.delete(emit);
          stopExpansion();
          stopQuery();
          observer.destroy();
        },
      };
    },
    refresh: (projectId, periodic) =>
      refreshSandbox(client, projectId, periodic),
    dispose: () => {
      trees.clear();
      client.clear();
    },
  };
};

/** `files.sandbox/v1` over a store. */
export const createFilesSandbox = (store: SandboxStore) =>
  defineService(FilesSandboxV1, {
    observeTree: defineMethod({
      ...filesSandboxMethods.observeTree,
      execute: ([scope, listener]: [
        TreeScope,
        (state: TreeObservation) => void,
      ]) => store.observeTree(scope, listener),
    }),
  });
