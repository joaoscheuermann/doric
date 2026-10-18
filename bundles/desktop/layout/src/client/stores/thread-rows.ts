import { ContractError, type Disposable } from 'bundle/contracts';
import { createStore } from 'zustand/vanilla';

import type { ThreadRows } from '../../contracts/index.js';

/**
 * The rows other bundles add under each Thread of the sidebar tree
 * (`layout.sidebar/v1.addThreadRows`), in registration order. `revision`
 * moves whenever a registration changes or one of its counts does, so the
 * tree re-reads `count`.
 */
export type ThreadRowsState = {
  readonly rows: readonly ThreadRows[];
  readonly revision: number;
};

export const threadRowsStore = createStore<ThreadRowsState>()(() => ({
  rows: [],
  revision: 0,
}));

const bump = (rows?: readonly ThreadRows[]): void =>
  threadRowsStore.setState((state) => ({
    rows: rows ?? state.rows,
    revision: state.revision + 1,
  }));

export const addThreadRows = (rows: ThreadRows): Disposable => {
  const { rows: current } = threadRowsStore.getState();
  const holder = current.find((entry) => entry.id === rows.id);
  if (holder !== undefined) {
    throw new ContractError(
      'registration_conflict',
      `The thread rows "${rows.id}" are already registered.`,
      { id: rows.id },
    );
  }
  bump([...current, rows]);
  const watch = rows.subscribe(() => bump());
  let active = true;
  return {
    dispose: () => {
      if (!active) return;
      active = false;
      watch.dispose();
      bump(threadRowsStore.getState().rows.filter((entry) => entry !== rows));
    },
  };
};

/** Whether any registration counts rows under the Thread. */
export const hasThreadRows = (
  rows: readonly ThreadRows[],
  threadId: string,
): boolean =>
  rows.some((entry) => {
    try {
      return entry.count(threadId) > 0;
    } catch {
      return false;
    }
  });

export const resetThreadRows = (): void => {
  threadRowsStore.setState({ rows: [], revision: 0 });
};
