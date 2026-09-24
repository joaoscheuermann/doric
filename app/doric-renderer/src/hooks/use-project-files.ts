import {
  isWithin,
  parentPath,
  ROOT_PATH,
  type SandboxStatus,
  toggleExpanded,
} from '@/domain/files';
import {
  messageFrom,
  type ProjectDiff,
  type ProjectFileContent,
  type ProjectFileEntry,
} from '@/domain/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One file is open at a time, so its read shares one key: opening another file
 * discards the one still on its way, and so does closing it.
 */
const OPEN_FILE = 'open-file';

/** One workspace diff is shown at a time, so it has one key too. */
const DIFF = 'diff';

export type ProjectFilesOptions = {
  /** The selected Project; the surface is empty without one. */
  readonly projectId?: string;
  /** Bumped by the conversation whenever the agent writes to the sandbox. */
  readonly revision: number;
};

/**
 * What a read of the sandbox answered. `idle` is "not asked yet", and the lease
 * states and the two refusals are data rather than failures, because the
 * surface explains them instead of erroring.
 */
export type ReadState<Value> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: SandboxStatus; readonly retryAfterSeconds?: number };

/** What the sandbox's directory reads answered: readable, or why it is not. */
export type SandboxState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: SandboxStatus; readonly retryAfterSeconds?: number };

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
 * can ask it to do: the listings it holds, what is expanded, the one open file,
 * the workspace diff, and the reasons any of those may be unavailable.
 */
export type ProjectFiles = {
  readonly actions: ProjectFilesActions;
  /** The workspace diff behind the changes view, once it has been asked for. */
  readonly changes: ReadState<ProjectDiff>;
  /** The last rejected read; the panel shows it and Refresh tries again. */
  readonly error?: string;
  readonly expanded: ReadonlySet<string>;
  /** The open file's content, or why there is none. */
  readonly file: ReadState<ProjectFileContent>;
  /** The entries per directory path, for the directories the host answered. */
  readonly listings: Readonly<Record<string, readonly ProjectFileEntry[]>>;
  /** The directories whose listing is still on its way. */
  readonly loading: ReadonlySet<string>;
  /**
   * What the sandbox's directory reads answered. A directory that answers with
   * anything but its entries replaces this, so the panel explains the sandbox
   * rather than the tree explaining one row of it; a refused file or diff is
   * explained where it was asked for instead.
   */
  readonly sandbox: SandboxState;
  readonly selectedPath?: string;
  /** The byte size the open file's parent listing reported, when it did. */
  readonly selectedSize?: number;
};

/**
 * The sandbox surface of one Project. The sandbox belongs to the Project rather
 * than to a Thread, so this hook reads only the Project it is given and forgets
 * everything the previous one answered.
 *
 * Two things drive it: the Project, which starts the surface over and reads the
 * root of the new sandbox, and `revision` growing, which rereads everything on
 * screen because the agent has just written to the sandbox. There is no watcher;
 * the surface reads on demand and never writes.
 */
export const useProjectFiles = ({
  projectId,
  revision,
}: ProjectFilesOptions): ProjectFiles => {
  const [listings, setListings] = useState<
    Readonly<Record<string, readonly ProjectFileEntry[]>>
  >({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sandbox, setSandbox] = useState<SandboxState>({ status: 'loading' });
  const [selectedPath, setSelectedPath] = useState<string>();
  const [file, setFile] = useState<ReadState<ProjectFileContent>>({
    status: 'idle',
  });
  const [changes, setChanges] = useState<ReadState<ProjectDiff>>({
    status: 'idle',
  });
  const [error, setError] = useState<string>();
  /**
   * The generation advances with the Project, and every read is keyed by what it
   * answers about, so an answer to a question the surface has already moved past
   * cannot land.
   */
  const generation = useRef(0);
  const sequences = useRef(new Map<string, number>());
  const seenRevision = useRef(revision);

  const begin = useCallback((key: string): (() => boolean) => {
    const generationAt = generation.current;
    const sequence = (sequences.current.get(key) ?? 0) + 1;
    sequences.current.set(key, sequence);
    return () =>
      generation.current === generationAt &&
      sequences.current.get(key) === sequence;
  }, []);

  const loadDirectory = useCallback(
    async (project: string, path: string): Promise<void> => {
      const stillCurrent = begin(path);
      setLoading((current) => new Set([...current, path]));
      try {
        const result = await window.doric.projects.files(project, path);
        if (!stillCurrent()) return;
        if (result.status === 'ready') {
          setListings((current) => ({
            ...current,
            // A directory nests only what it contains, so an entry the host put
            // beside it is dropped rather than shown in the wrong level.
            [path]: result.entries.filter((entry) =>
              isWithin(entry.path, path),
            ),
          }));
          if (path === ROOT_PATH) setSandbox({ status: 'ready' });
        } else {
          setSandbox(result);
        }
      } catch (reason) {
        if (stillCurrent()) setError(messageFrom(reason));
      } finally {
        if (stillCurrent()) {
          setLoading((current) => {
            if (!current.has(path)) return current;
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        }
      }
    },
    [begin],
  );

  const loadFile = useCallback(
    async (project: string, path: string): Promise<void> => {
      const stillCurrent = begin(OPEN_FILE);
      setFile({ status: 'loading' });
      try {
        const result = await window.doric.projects.file(project, path);
        if (!stillCurrent()) return;
        setFile(
          result.status === 'ready'
            ? { status: 'ready', value: result.file }
            : result,
        );
      } catch (reason) {
        if (!stillCurrent()) return;
        // The panel explains the failure, and the tree stays where it was.
        setSelectedPath(undefined);
        setFile({ status: 'idle' });
        setError(messageFrom(reason));
      }
    },
    [begin],
  );

  const loadChanges = useCallback(
    async (project: string): Promise<void> => {
      const stillCurrent = begin(DIFF);
      setChanges({ status: 'loading' });
      try {
        const result = await window.doric.projects.diff(project);
        if (!stillCurrent()) return;
        setChanges(
          result.status === 'ready'
            ? { status: 'ready', value: result.diff }
            : result,
        );
      } catch (reason) {
        if (!stillCurrent()) return;
        // A diff already on screen is worth more than a placeholder.
        setChanges((current) =>
          current.status === 'ready' ? current : { status: 'idle' },
        );
        setError(messageFrom(reason));
      }
    },
    [begin],
  );

  /** Rereads everything the surface is currently showing. */
  const reload = useCallback((): void => {
    if (projectId === undefined) return;
    void loadDirectory(projectId, ROOT_PATH);
    for (const path of expanded) void loadDirectory(projectId, path);
    if (selectedPath !== undefined) void loadFile(projectId, selectedPath);
    if (changes.status !== 'idle') void loadChanges(projectId);
  }, [
    changes.status,
    expanded,
    loadChanges,
    loadDirectory,
    loadFile,
    projectId,
    selectedPath,
  ]);

  // A new Project is a new sandbox, and the generation moves with it, so every
  // answer the previous Project still owes is dropped when it arrives.
  useEffect(() => {
    generation.current += 1;
    setListings({});
    setLoading(new Set());
    setExpanded(new Set());
    setSelectedPath(undefined);
    setFile({ status: 'idle' });
    setChanges({ status: 'idle' });
    setError(undefined);
    if (projectId === undefined) {
      setSandbox({ status: 'idle' });
      return;
    }
    setSandbox({ status: 'loading' });
    void loadDirectory(projectId, ROOT_PATH);
  }, [loadDirectory, projectId]);

  // The agent wrote to the sandbox, so what the surface shows may be stale.
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    reload();
  }, [reload, revision]);

  const toggleDirectory = useCallback(
    (path: string): void => {
      const next = toggleExpanded(expanded, path);
      setExpanded(next);
      // A directory is read when it opens for the first time; a listing the
      // surface already holds is kept, so closing and opening is free.
      if (
        projectId !== undefined &&
        next.has(path) &&
        listings[path] === undefined &&
        !loading.has(path)
      ) {
        void loadDirectory(projectId, path);
      }
    },
    [expanded, listings, loadDirectory, loading, projectId],
  );

  const openFile = useCallback(
    (path: string): void => {
      if (projectId === undefined) return;
      setSelectedPath(path);
      void loadFile(projectId, path);
    },
    [loadFile, projectId],
  );

  const closeFile = useCallback((): void => {
    // Closing states that the file is no longer shown, so a read still on its
    // way for it is discarded instead of landing on a closed surface.
    begin(OPEN_FILE);
    setSelectedPath(undefined);
    setFile({ status: 'idle' });
  }, [begin]);

  const loadRequestedChanges = useCallback((): void => {
    if (projectId === undefined) return;
    void loadChanges(projectId);
  }, [loadChanges, projectId]);

  const refresh = useCallback((): void => {
    setError(undefined);
    reload();
  }, [reload]);

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

  const selectedSize =
    selectedPath === undefined
      ? undefined
      : listings[parentPath(selectedPath)]?.find(
          (entry) => entry.path === selectedPath,
        )?.size;

  return {
    actions,
    changes,
    error,
    expanded,
    file,
    listings,
    loading,
    sandbox,
    selectedPath,
    selectedSize,
  };
};
