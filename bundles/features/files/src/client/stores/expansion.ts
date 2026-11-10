import { toggleExpanded } from 'desktop/ui/panels';
import { createStore } from 'zustand/vanilla';

/**
 * The directories the reader opened, per Project and root (`stores/files.ts`
 * `expanded`). View state, not read state: it outlives the tree query, so
 * switching away and back keeps what was open.
 */
type ExpansionState = {
  readonly views: Readonly<Record<string, ReadonlySet<string>>>;
  readonly toggle: (scope: string, path: string) => void;
  /** Opens these directories of the scope; open ones stay open (S16). */
  readonly expand: (scope: string, paths: readonly string[]) => void;
};

export const emptyExpansion: ReadonlySet<string> = new Set<string>();

export const expansionStore = createStore<ExpansionState>()((set) => ({
  views: {},
  toggle: (scope, path) =>
    set((state) => ({
      views: {
        ...state.views,
        [scope]: toggleExpanded(state.views[scope] ?? emptyExpansion, path),
      },
    })),
  expand: (scope, paths) =>
    set((state) => {
      const open = state.views[scope] ?? emptyExpansion;
      if (paths.every((path) => open.has(path))) return state;
      return {
        views: { ...state.views, [scope]: new Set([...open, ...paths]) },
      };
    }),
}));

/** The key of one Project and root's view state. */
export const expansionScope = (projectId: string, root: string): string =>
  JSON.stringify([projectId, root]);

export const resetExpansion = (): void => {
  expansionStore.setState({ views: {} });
};
