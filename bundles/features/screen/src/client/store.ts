// The window's screen state: one panel per Project, keyed by the Project id
// so sibling Threads of the same Project share it. The store owns what the
// reader sees — open, geometry, and the attach status — and the panel element
// only renders it. Nothing here holds a timer or a socket; a closed panel
// keeps its last state, and the element decides when to ask again.

import type { Disposable } from 'bundle/contracts';

import type {
  ScreenAttach,
  ScreenUnavailableReason,
} from '../contracts/index.js';
import type { ScreenGeometry } from './domain/geometry.js';

export type ScreenStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly url: string; readonly display: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable'; readonly reason: ScreenUnavailableReason }
  | { readonly kind: 'failed' };

export interface ScreenPanel {
  readonly open: boolean;
  readonly status: ScreenStatus;
  /** Absent until the reader moved or resized the panel. */
  readonly geometry?: ScreenGeometry;
}

export interface ScreenStoreOptions {
  readonly attach: (projectId: string) => Promise<ScreenAttach>;
}

export interface ScreenStore {
  /** The Project's panel, once its Project was opened at least once. */
  panel(projectId: string): ScreenPanel | undefined;
  /** Every Project whose panel is mounted, in first-open order. */
  mounted(): readonly string[];
  open(projectId: string): void;
  close(projectId: string): void;
  toggle(projectId: string): void;
  /** Asks for a fresh attach; the retry control and the pending loop use it. */
  retry(projectId: string): void;
  setGeometry(projectId: string, geometry: ScreenGeometry): void;
  subscribe(listener: () => void): Disposable;
  dispose(): void;
}

const statusOf = (attach: ScreenAttach): ScreenStatus => {
  if (attach.status === 'ready') {
    return { kind: 'ready', url: attach.url, display: attach.display };
  }

  return attach.status === 'pending'
    ? { kind: 'pending' }
    : { kind: 'unavailable', reason: attach.reason };
};

export const createScreenStore = (options: ScreenStoreOptions): ScreenStore => {
  const panels = new Map<string, ScreenPanel>();
  const order: string[] = [];
  const listeners = new Set<() => void>();
  let mounted: readonly string[] = Object.freeze([]);

  const changed = () => {
    // The mounted list keeps its identity while the Projects do not change,
    // so a panel's status update re-renders only that panel.
    if (
      mounted.length !== order.length ||
      order.some((id, index) => mounted[index] !== id)
    ) {
      mounted = Object.freeze([...order]);
    }

    for (const listener of [...listeners]) {
      listener();
    }
  };

  const update = (projectId: string, next: Partial<ScreenPanel>) => {
    const current = panels.get(projectId);

    if (current === undefined) {
      return;
    }

    panels.set(projectId, { ...current, ...next });
    changed();
  };

  const ensure = (projectId: string): ScreenPanel => {
    const existing = panels.get(projectId);

    if (existing !== undefined) {
      return existing;
    }

    const created: ScreenPanel = { open: false, status: { kind: 'loading' } };

    panels.set(projectId, created);
    order.push(projectId);

    return created;
  };

  const attach = async (projectId: string) => {
    const current = panels.get(projectId);

    if (current === undefined) {
      return;
    }

    if (current.status.kind !== 'ready') {
      update(projectId, { status: { kind: 'loading' } });
    }

    try {
      const status = statusOf(await options.attach(projectId));
      const now = panels.get(projectId);

      // A background refresh never blanks a screen that is already up.
      if (
        now === undefined ||
        (now.status.kind === 'ready' && status.kind !== 'ready')
      ) {
        return;
      }

      update(projectId, { status });
    } catch {
      const now = panels.get(projectId);

      if (now === undefined || now.status.kind === 'ready') {
        return;
      }

      update(projectId, { status: { kind: 'failed' } });
    }
  };

  return {
    panel: (projectId) => panels.get(projectId),
    mounted: () => mounted,
    open: (projectId) => {
      const panel = ensure(projectId);

      if (!panel.open) {
        update(projectId, { open: true });
      }

      void attach(projectId);
    },
    close: (projectId) => {
      update(projectId, { open: false });
    },
    toggle: (projectId) => {
      if (panels.get(projectId)?.open === true) {
        update(projectId, { open: false });

        return;
      }

      const panel = ensure(projectId);

      if (!panel.open) {
        update(projectId, { open: true });
      }

      void attach(projectId);
    },
    retry: (projectId) => {
      void attach(projectId);
    },
    setGeometry: (projectId, geometry) => {
      update(projectId, { geometry });
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose: () => {
      panels.clear();
      order.length = 0;
      listeners.clear();
    },
  };
};
