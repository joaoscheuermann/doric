// The sidebar stack's registry and open state (`layout.stack/v1`): the panes
// bundles register plus the layout's own, and which of them is expanded. The
// panels' geometry belongs to the view (`organisms/project-sidebar.tsx`); this
// holds only what is drawn and what is collapsed, so another bundle can read and
// drive its own group without knowing how the stack is built.

import { ContractError, type Disposable } from 'bundle/contracts';
import { createStore } from 'zustand/vanilla';

import type { StackPane } from '../../contracts/index.js';
import { orderedPanes } from '../domain/sidebar-stack.js';

export type StackState = {
  /** The panes top to bottom; a new array only when the stack changes. */
  readonly panes: readonly StackPane[];
  /** Whether each pane is expanded, by pane id. */
  readonly open: Readonly<Record<string, boolean>>;
};

export const initialStack: StackState = Object.freeze({
  panes: Object.freeze([]) as readonly StackPane[],
  open: Object.freeze({}) as Readonly<Record<string, boolean>>,
});

export const stackStore = createStore<StackState>()(() => initialStack);

/** A pane that does not say otherwise is the reader's to collapse. */
const isCollapsible = (pane: StackPane): boolean => pane.collapsible !== false;

export const registerPane = (pane: StackPane): Disposable => {
  const { panes } = stackStore.getState();
  if (panes.some((entry) => entry.id === pane.id)) {
    throw new ContractError(
      'registration_conflict',
      `The sidebar pane "${pane.id}" is already registered.`,
      { id: pane.id },
    );
  }

  stackStore.setState((state) => ({
    panes: orderedPanes([...state.panes, pane]),
    open: { ...state.open, [pane.id]: pane.initiallyOpen !== false },
  }));

  let active = true;

  return {
    dispose: () => {
      if (!active) return;
      active = false;
      stackStore.setState((state) => {
        const open: Record<string, boolean> = { ...state.open };
        delete open[pane.id];
        return {
          panes: state.panes.filter((entry) => entry !== pane),
          open,
        };
      });
    },
  };
};

/**
 * Whether the pane is expanded. A pane that cannot collapse always is: the
 * layout draws no control for it and no drag can close it.
 */
export const isPaneOpen = (paneId: string): boolean => {
  const { panes, open } = stackStore.getState();
  const pane = panes.find((entry) => entry.id === paneId);
  if (pane === undefined) return false;

  return isCollapsible(pane) ? (open[paneId] ?? true) : true;
};

export const setPaneOpen = (paneId: string, next: boolean): void => {
  const { panes } = stackStore.getState();
  const pane = panes.find((entry) => entry.id === paneId);
  if (pane === undefined || !isCollapsible(pane)) return;

  stackStore.setState((state) =>
    state.open[paneId] === next
      ? state
      : { open: { ...state.open, [paneId]: next } },
  );
};

export const togglePane = (paneId: string): void => {
  setPaneOpen(paneId, !isPaneOpen(paneId));
};

export const resetStack = (): void => {
  stackStore.setState(initialStack);
};
