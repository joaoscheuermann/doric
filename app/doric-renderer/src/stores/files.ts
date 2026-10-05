import { toggleExpanded } from '@/domain/files';
import { createStore } from 'zustand/vanilla';

/** View state is retained per Project/root, independently of query lifetimes. */
export type FilesView = {
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly changesRequested: boolean;
};

export const emptyFilesView: FilesView = {
  expanded: new Set<string>(),
  changesRequested: false,
};

type FilesState = {
  readonly views: Readonly<Record<string, FilesView>>;
  readonly toggleDirectory: (scope: string, path: string) => void;
  readonly openFile: (scope: string, path: string) => void;
  readonly closeFile: (scope: string) => void;
  readonly requestChanges: (scope: string) => void;
  readonly hideChanges: (scope: string) => void;
};

export const filesStore = createStore<FilesState>()((set) => {
  const update = (
    scope: string,
    change: (view: FilesView) => FilesView,
  ): void =>
    set((state) => ({
      views: {
        ...state.views,
        [scope]: change(state.views[scope] ?? emptyFilesView),
      },
    }));
  return {
    views: {},
    toggleDirectory: (scope, path) =>
      update(scope, (view) => ({
        ...view,
        expanded: toggleExpanded(view.expanded, path),
      })),
    openFile: (scope, path) =>
      update(scope, (view) => ({ ...view, selectedPath: path })),
    closeFile: (scope) =>
      update(scope, (view) => ({ ...view, selectedPath: undefined })),
    requestChanges: (scope) =>
      update(scope, (view) => ({ ...view, changesRequested: true })),
    hideChanges: (scope) =>
      update(scope, (view) => ({ ...view, changesRequested: false })),
  };
});
