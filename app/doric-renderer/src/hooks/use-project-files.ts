import { workspacePath } from '@/domain/cwd';
import {
  diffReadState,
  fileReadState,
  type ReadState,
  ROOT_PATH,
  treeReadState,
} from '@/domain/files';
import {
  messageFrom,
  type ProjectDiff,
  type ProjectFileContent,
  type ProjectTreeNode,
} from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { filesStore } from '@/stores/files';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand/react';

export type { ReadState };

export type ProjectFilesOptions = {
  /** The selected Project; the surface is empty without one. */
  readonly projectId?: string;
  /**
   * The selected Thread's working directory, sandbox-absolute. The panel draws
   * the tree from it, and the changes view looks at the repository it sits in;
   * without one the panel draws the Project's workspace root.
   */
  readonly cwd?: string;
  /** Bumped by the conversation whenever the agent writes to the sandbox. */
  readonly revision: number;
};

export type ProjectFilesActions = {
  readonly closeFile: () => void;
  /** Reads the workspace diff; the changes view is what asks for it. */
  readonly loadChanges: () => void;
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
  /** The cwd repository's diff, behind the changes view, once it is asked for. */
  readonly changes: ReadState<ProjectDiff>;
  /** The last rejected read; the panel shows it and Refresh tries again. */
  readonly error?: string;
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
 * the cwd names, and forgets everything the previous root answered.
 *
 * Two things drive it: the Project or the cwd, which starts the surface over and
 * reads the whole tree of the new root in one request, and `revision` growing,
 * which invalidates what is on screen because the agent has just written to the
 * sandbox. There is no watcher: the surface reads on demand and never writes,
 * and one file's content is read only when it is opened.
 */
export const useProjectFiles = ({
  projectId,
  cwd,
  revision,
}: ProjectFilesOptions): ProjectFiles => {
  const queryClient = useQueryClient();
  const expanded = useStore(filesStore, (state) => state.expanded);
  const selectedPath = useStore(filesStore, (state) => state.selectedPath);
  const changesRequested = useStore(
    filesStore,
    (state) => state.changesRequested,
  );
  const [error, setError] = useState<string>();
  const {
    closeFile: closeStoredFile,
    dropChanges,
    openFile: openStoredFile,
    requestChanges,
    reset,
    toggleDirectory: toggleStoredDirectory,
  } = filesStore.getState();

  // The sandbox speaks workspace-relative paths; the Thread's cwd is
  // sandbox-absolute, and the root of the mount is the empty path.
  const root = cwd === undefined ? ROOT_PATH : workspacePath(cwd);

  const tree = useQuery({
    queryKey: queryKeys.files.tree(projectId, cwd),
    queryFn: () => window.doric.projects.tree(projectId as string, root),
    enabled: projectId !== undefined,
    gcTime: 0,
  });
  const file = useQuery({
    queryKey: queryKeys.files.file(projectId, selectedPath),
    queryFn: () =>
      window.doric.projects.file(projectId as string, selectedPath as string),
    enabled: projectId !== undefined && selectedPath !== undefined,
    gcTime: 0,
  });
  const changes = useQuery({
    queryKey: queryKeys.files.diff(projectId, cwd),
    queryFn: () =>
      window.doric.projects.diff(
        projectId as string,
        root === ROOT_PATH ? undefined : root,
      ),
    enabled: projectId !== undefined && changesRequested,
    gcTime: 0,
  });

  // A new Project is a new sandbox and a new cwd is a new root within it, so
  // nothing of the old surface stays open and no answer the previous root still
  // owes can land on the new one.
  const previousRoot = useRef({ projectId, root });
  useEffect(() => {
    if (
      previousRoot.current.projectId === projectId &&
      previousRoot.current.root === root
    ) {
      return;
    }
    previousRoot.current = { projectId, root };
    reset();
    setError(undefined);
  }, [projectId, reset, root]);

  // The agent wrote to the sandbox, so what the surface shows may be stale.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.files.ofProject(projectId),
    });
  }, [projectId, queryClient, revision]);

  // The last rejected read is the one the panel explains; Refresh and a new
  // Project are what clear it.
  useEffect(() => {
    if (tree.isError) setError(messageFrom(tree.error));
  }, [tree.error, tree.errorUpdatedAt, tree.isError]);
  useEffect(() => {
    if (file.isError) {
      // The panel explains the failure, and the tree stays where it was.
      closeStoredFile();
      setError(messageFrom(file.error));
    }
  }, [closeStoredFile, file.error, file.errorUpdatedAt, file.isError]);
  useEffect(() => {
    if (changes.isError) {
      setError(messageFrom(changes.error));
      // A diff that answered nothing leaves the changes view unasked.
      if (changes.data === undefined) dropChanges();
    }
  }, [
    changes.data,
    changes.error,
    changes.errorUpdatedAt,
    changes.isError,
    dropChanges,
  ]);

  /**
   * A directory is only shown or hidden: the whole tree is already held, so
   * expanding one reads nothing.
   */
  const toggleDirectory = useCallback(
    (path: string): void => toggleStoredDirectory(path),
    [toggleStoredDirectory],
  );

  const openFile = useCallback(
    (path: string): void => {
      if (projectId === undefined) return;
      openStoredFile(path);
      // Opening the file already open still reads it again.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.files.file(projectId, path),
      });
    },
    [openStoredFile, projectId, queryClient],
  );

  const closeFile = useCallback((): void => {
    // Closing states that the file is no longer shown, so a read still on its
    // way for it is discarded instead of landing on a closed surface.
    closeStoredFile();
  }, [closeStoredFile]);

  const loadRequestedChanges = useCallback((): void => {
    if (projectId === undefined) return;
    requestChanges();
    void queryClient.invalidateQueries({
      queryKey: queryKeys.files.diff(projectId, cwd),
    });
  }, [cwd, projectId, queryClient, requestChanges]);

  const refresh = useCallback((): void => {
    setError(undefined);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.files.ofProject(projectId),
    });
  }, [projectId, queryClient]);

  const actions = useMemo(
    () => ({
      closeFile,
      loadChanges: loadRequestedChanges,
      openFile,
      refresh,
      toggleDirectory,
    }),
    [closeFile, loadRequestedChanges, openFile, refresh, toggleDirectory],
  );

  return {
    actions,
    changes:
      projectId === undefined || !changesRequested
        ? { status: 'idle' }
        : diffReadState(
            changes.data,
            changes.isPending || changes.isFetching,
            changes.isError,
          ),
    error,
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
