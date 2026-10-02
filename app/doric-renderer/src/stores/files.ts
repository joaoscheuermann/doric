import { toggleExpanded } from '@/domain/files';
import { createStore } from 'zustand/vanilla';

/**
 * The files panel's view state: what is expanded, the one open file, and
 * whether the changes view has asked for the diff. The reads themselves are
 * queries; this only remembers what the user left on screen.
 */
export type FilesState = {
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly changesRequested: boolean;
  readonly toggleDirectory: (path: string) => void;
  readonly openFile: (path: string) => void;
  readonly closeFile: () => void;
  readonly requestChanges: () => void;
  /** A diff that failed without answering leaves nothing asked for. */
  readonly dropChanges: () => void;
  /** A new Project is a new sandbox, so nothing of the old one stays open. */
  readonly reset: () => void;
};

export const filesStore = createStore<FilesState>()((set) => ({
  expanded: new Set<string>(),
  changesRequested: false,
  toggleDirectory: (path) =>
    set((state) => ({ expanded: toggleExpanded(state.expanded, path) })),
  openFile: (path) => set(() => ({ selectedPath: path })),
  closeFile: () => set(() => ({ selectedPath: undefined })),
  requestChanges: () => set(() => ({ changesRequested: true })),
  dropChanges: () => set(() => ({ changesRequested: false })),
  reset: () =>
    set(() => ({
      expanded: new Set<string>(),
      selectedPath: undefined,
      changesRequested: false,
    })),
}));
