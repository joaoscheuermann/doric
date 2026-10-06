import { createStore } from 'zustand/vanilla';

import { toggleExpanded } from '@/domain/files';

/** View state is retained per Project/root, independently of query lifetimes. */
export type FilesView = {
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly changesCollapsed: ReadonlySet<string>;
};

export const emptyFilesView: FilesView = {
  expanded: new Set<string>(),
  changesCollapsed: new Set<string>(),
};

type FilesState = {
  readonly views: Readonly<Record<string, FilesView>>;
  readonly toggleDirectory: (scope: string, path: string) => void;
  readonly openFile: (scope: string, path: string) => void;
  readonly closeFile: (scope: string) => void;
  readonly toggleChangesDirectory: (scope: string, path: string) => void;
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
    toggleChangesDirectory: (scope, path) =>
      update(scope, (view) => ({
        ...view,
        changesCollapsed: toggleExpanded(view.changesCollapsed, path),
      })),
  };
});
