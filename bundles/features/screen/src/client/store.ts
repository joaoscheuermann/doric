// The window's mirror of the desktop part's views: the last list it was sent,
// with the snapshot identity `useSyncExternalStore` needs. The desktop part
// owns the state; this only holds what it read and notifies on a real change.

import type { Disposable } from 'bundle/contracts';

import type { ScreenView } from '../contracts/index.js';

const NONE: readonly ScreenView[] = Object.freeze([]);

const sameStatus = (left: ScreenView, right: ScreenView): boolean => {
  const a = left.status;
  const b = right.status;

  if (a.kind !== b.kind) return false;
  if (a.kind === 'ready') return a.path === (b as typeof a).path;
  if (a.kind === 'unavailable') return a.reason === (b as typeof a).reason;

  return true;
};

const sameViews = (
  left: readonly ScreenView[],
  right: readonly ScreenView[],
): boolean =>
  left.length === right.length &&
  left.every((view, index) => {
    const other = right[index] as ScreenView;

    return (
      view.id === other.id &&
      view.label === other.label &&
      view.projectId === other.projectId &&
      sameStatus(view, other)
    );
  });

export interface ScreenViewsStore {
  /** The list as the last notification carried it; stable until it changes. */
  views(): readonly ScreenView[];
  /** Replaces the list; an unchanged list notifies nobody. */
  set(views: readonly ScreenView[]): void;
  subscribe(listener: () => void): Disposable;
  reset(): void;
}

export const createScreenViewsStore = (): ScreenViewsStore => {
  let views: readonly ScreenView[] = NONE;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One listener never reaches another.
      }
    }
  };

  return {
    views: () => views,
    set: (next) => {
      const frozen = Object.freeze([...next]);

      if (sameViews(frozen, views)) return;

      views = frozen;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    reset: () => {
      if (views.length === 0) return;

      views = NONE;
      notify();
    },
  };
};
