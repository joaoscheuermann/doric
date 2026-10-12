import { createStore } from 'zustand/vanilla';

/**
 * The items that asked for the `layout.main.bottom` split
 * (`layout.workspace/v1.setBottomVisible`). The split is shown while this set
 * is not empty.
 */
export type BottomState = {
  readonly visible: ReadonlySet<string>;
  set(itemId: string, visible: boolean): void;
};

export const bottomStore = createStore<BottomState>()((set) => ({
  visible: new Set(),
  set: (itemId, visible) =>
    set((state) => {
      if (state.visible.has(itemId) === visible) return state;
      const next = new Set(state.visible);
      if (visible) next.add(itemId);
      else next.delete(itemId);
      return { visible: next };
    }),
}));

export const resetBottom = (): void => {
  bottomStore.setState({ visible: new Set() });
};
