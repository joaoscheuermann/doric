import { toggleExpanded } from 'desktop-ui/panels';
import { createStore } from 'zustand/vanilla';

/**
 * The directories the reader opened, per Project and root (`stores/files.ts`
 * `expanded`). View state, not read state: it outlives the tree query, so
 * switching away and back keeps what was open.
 */
type ExpansionState = {
  readonly views: Readonly<Record<string, ReadonlySet<string>>>;
  readonly toggle: (scope: string, path: string) => void;
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
}));

/** The key of one Project and root's view state. */
export const expansionScope = (projectId: string, root: string): string =>
  JSON.stringify([projectId, root]);

export const resetExpansion = (): void => {
  expansionStore.setState({ views: {} });
};
