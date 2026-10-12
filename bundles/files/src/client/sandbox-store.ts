// files.sandbox/v1 (stage 10, §3.6): the window's query client of the files
// bundle and its tree read, moved from the tree part of the layout's
// `useProjectFiles`. The tree query keeps its key, `['files', p, 'tree', cwd]`,
// so the Project's `['files', p, …]` targeting is unchanged; it retries a
// failed read a bounded number of times and polls a pending lease at the
// host's hint. It is enabled only while something observes it.

import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { type Disposable, defineMethod, defineService } from 'bundle/contracts';
import {
  messageFrom,
  pendingReadInterval,
  readRetry,
  refreshQueries,
} from 'desktop-reads';

import {
  FilesSandboxV1,
  filesSandboxMethods,
  ROOT_PATH,
  type TreeObservation,
  type TreeScope,
  workspacePath,
} from '../contracts/index.js';
import type { FilesReads } from './api/reads.js';
import type { ProjectTreeResult } from './reads/project-files.js';
import { treeReadState } from './reads/state.js';

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

export const createSandboxStore = (
  reads: () => FilesReads,
  client: QueryClient = createQueryClient(),
): SandboxStore => ({
  client,
  observeTree: ({ projectId, cwd }, listener) => {
    const root = rootOf(cwd);
    const observer = new QueryObserver<ProjectTreeResult, Error>(client, {
      queryKey: filesKeys.tree(projectId, cwd),
      queryFn: () => reads().tree(projectId, root),
      ...readRetry,
      refetchInterval: (query) =>
        query.state.status === 'error'
          ? false
          : pendingReadInterval(query.state.data),
    });
    const emit = () => {
      const result = observer.getCurrentResult();
      listener({
        read: treeReadState(result.data, result.isError),
        ...(result.isError ? { error: messageFrom(result.error) } : {}),
        fetching: result.isFetching,
      });
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
  refresh: (projectId, periodic) => refreshSandbox(client, projectId, periodic),
  dispose: () => client.clear(),
});

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
