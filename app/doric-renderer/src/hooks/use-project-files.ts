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
  /** The workspace diff behind the changes view, once it has been asked for. */
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
 * The sandbox surface of one Project. The sandbox belongs to the Project rather
 * than to a Thread, so this hook reads only the Project it is given and forgets
 * everything the previous one answered.
 *
 * Two things drive it: the Project, which starts the surface over and reads the
 * whole tree of the new sandbox in one request, and `revision` growing, which
 * invalidates what is on screen because the agent has just written to the
 * sandbox. There is no watcher: the surface reads on demand and never writes,
 * and one file's content is read only when it is opened.
 */
export const useProjectFiles = ({
  projectId,
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

  const tree = useQuery({
    queryKey: queryKeys.files.tree(projectId),
    queryFn: () => window.doric.projects.tree(projectId as string, ROOT_PATH),
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
    queryKey: queryKeys.files.diff(projectId),
    queryFn: () => window.doric.projects.diff(projectId as string),
    enabled: projectId !== undefined && changesRequested,
    gcTime: 0,
  });

  // A new Project is a new sandbox, so nothing of the old one stays open and no
  // answer the previous Project still owes can land on the new surface.
  const previousProject = useRef(projectId);
  useEffect(() => {
    if (previousProject.current === projectId) return;
    previousProject.current = projectId;
    reset();
    setError(undefined);
  }, [projectId, reset]);

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
      queryKey: queryKeys.files.diff(projectId),
    });
  }, [projectId, queryClient, requestChanges]);

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
