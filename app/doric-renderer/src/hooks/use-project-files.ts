import { workspacePath } from '@/domain/cwd';
import {
  fileReadState,
  type ReadState,
  ROOT_PATH,
  treeReadState,
} from '@/domain/files';
import { pendingReadInterval, sandboxReadRetry } from '@/domain/sandbox-reads';
import {
  messageFrom,
  type ProjectChanges,
  type ProjectFileContent,
  type ProjectTreeNode,
} from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { refreshProject } from '@/queries/project-refresh';
import { emptyFilesView, filesStore } from '@/stores/files';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand/react';

export type { ReadState };

export type ProjectFilesOptions = {
  readonly treeEnabled?: boolean;
  /** The selected Project; the surface is empty without one. */
  readonly projectId?: string;
  /**
   * The selected Thread's working directory, sandbox-absolute. The panel draws
   * the tree from it, and the changes view looks at the repository it sits in;
   * without one the panel draws the Project's workspace root.
   */
  readonly cwd?: string;
};

export type ProjectFilesActions = {
  readonly closeFile: () => void;
  readonly toggleChangesDirectory: (path: string) => void;
  readonly openFile: (path: string) => void;
  readonly refresh: () => void;
  readonly toggleDirectory: (path: string) => void;
};

/**
 * Everything the sandbox surface shows for one Project, and everything the user
 * can ask it to do: the whole tree it holds, what is expanded, the one open file,
 * the workspace diff, and the reasons any of those may be unavailable.
 */
export type ProjectFiles = {
  readonly actions: ProjectFilesActions;
  /** Lightweight Git status shared by the file and change trees. */
  readonly changes: ReadState<ProjectChanges>;
  readonly changesCollapsed: ReadonlySet<string>;
  /** Errors belong to their reads and disappear after successful recovery. */
  readonly error?: string;
  readonly treeError?: string;
  readonly changesError?: string;
  readonly fileError?: string;
  readonly refreshing: boolean;
  /**
   * The directories the user has opened. This is view state, not read state: the
   * whole tree is already held, so expanding a directory only decides what the
   * tree draws.
   */
  readonly expanded: ReadonlySet<string>;
  /** The open file's content, or why there is none. */
  readonly file: ReadState<ProjectFileContent>;
  /**
   * The whole sandbox tree, read once. Its presence is also what says the sandbox
   * is readable, because one read settles both questions at the same time.
   */
  readonly tree: ReadState<readonly ProjectTreeNode[]>;
  readonly selectedPath?: string;
};

/**
 * The sandbox surface of one Project, rooted at the selected Thread's working
 * directory. The sandbox belongs to the Project, but what a Thread sees of it
 * starts at its own cwd, so this hook reads the Project it is given and the root
 * the cwd names. Query keys isolate roots while their expansion state survives
 * switching away. The project refresh coordinator owns invalidation signals;
 * queries own only recovery from pending leases and failed reads.
 */
export const useProjectFiles = ({
  projectId,
  cwd,
  treeEnabled = true,
}: ProjectFilesOptions): ProjectFiles => {
  const queryClient = useQueryClient();
  const root = cwd === undefined ? ROOT_PATH : workspacePath(cwd);
  const scope = JSON.stringify([projectId, root]);
  const { expanded, selectedPath, changesCollapsed } = useStore(
    filesStore,
    (state) => state.views[scope] ?? emptyFilesView,
  );
  const {
    closeFile: closeStoredFile,
    openFile: openStoredFile,
    toggleChangesDirectory: toggleStoredChangesDirectory,
    toggleDirectory: toggleStoredDirectory,
  } = filesStore.getState();

  const tree = useQuery({
    queryKey: queryKeys.files.tree(projectId, cwd),
    queryFn: () => window.doric.projects.tree(projectId as string, root),
    enabled: projectId !== undefined && treeEnabled,
    ...sandboxReadRetry,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
  const file = useQuery({
    queryKey: queryKeys.files.file(projectId, selectedPath),
    queryFn: () =>
      window.doric.projects.file(projectId as string, selectedPath as string),
    enabled: projectId !== undefined && selectedPath !== undefined,
    ...sandboxReadRetry,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
  const changes = useQuery({
    queryKey: queryKeys.files.changes(projectId, cwd),
    queryFn: () =>
      window.doric.projects.changes(
        projectId as string,
        root === ROOT_PATH ? undefined : root,
      ),
    enabled: projectId !== undefined,
    ...sandboxReadRetry,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });

  const treeError = tree.isError ? messageFrom(tree.error) : undefined;
  const fileError =
    selectedPath !== undefined && file.isError
      ? messageFrom(file.error)
      : undefined;
  const changesError = changes.isError ? messageFrom(changes.error) : undefined;

  /**
   * A directory is only shown or hidden: the whole tree is already held, so
   * expanding one reads nothing.
   */
  const toggleDirectory = useCallback(
    (path: string): void => toggleStoredDirectory(scope, path),
    [scope, toggleStoredDirectory],
  );

  const openFile = useCallback(
    (path: string): void => {
      if (projectId === undefined) return;
      openStoredFile(scope, path);
      // Opening the file already open still reads it again.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.files.file(projectId, path),
      });
    },
    [openStoredFile, projectId, queryClient, scope],
  );

  const closeFile = useCallback((): void => {
    // A late result may fill the cache, but never reopens the closed surface.
    closeStoredFile(scope);
  }, [closeStoredFile, scope]);

  const toggleChangesDirectory = useCallback(
    (path: string) => toggleStoredChangesDirectory(scope, path),
    [scope, toggleStoredChangesDirectory],
  );

  const refresh = useCallback((): void => {
    if (projectId !== undefined) void refreshProject(queryClient, projectId);
  }, [projectId, queryClient]);

  const actions = useMemo(
    () => ({
      closeFile,
      toggleChangesDirectory,
      openFile,
      refresh,
      toggleDirectory,
    }),
    [closeFile, toggleChangesDirectory, openFile, refresh, toggleDirectory],
  );

  return {
    actions,
    changes:
      projectId === undefined
        ? { status: 'idle' }
        : changes.data?.status === 'ready'
          ? { status: 'ready', value: changes.data.changes }
          : (changes.data ?? {
              status: changes.isPending ? 'loading' : 'idle',
            }),
    changesCollapsed,
    error: treeError ?? changesError ?? fileError,
    treeError,
    changesError,
    fileError,
    refreshing: tree.isFetching || file.isFetching || changes.isFetching,
    expanded,
    file:
      projectId === undefined || selectedPath === undefined
        ? { status: 'idle' }
        : fileReadState(
            file.data,
            file.isPending || file.isFetching,
            file.isError,
          ),
    tree:
      projectId === undefined
        ? { status: 'idle' }
        : treeReadState(tree.data, tree.isError),
    selectedPath,
  };
};
