import type { RouteMatch } from 'bundle/contracts';
import { createStore } from 'zustand/vanilla';

import type { Selection } from '../domain/project-tree.js';
import {
  PROJECTS_ROUTE,
  pathFor,
  routeThread,
  WORKSPACE_ROUTE,
} from '../domain/route-selection.js';
import {
  parseSelection,
  type SelectionLoad,
  selectionStorageKey,
  shouldWriteSelection,
} from '../domain/selection.js';
import type { Thread } from '../domain/workspace.js';

/**
 * Where the selection is written: the window path. `navigate` pushes an entry
 * for a selection the user made and replaces the current one otherwise.
 */
export interface RouteWriter {
  /** The current window path, or undefined when no route matches. */
  path(): string | undefined;
  navigate(path: string, options: { readonly replace: boolean }): void;
}

/**
 * The selected Thread and its persistence in the window path (stage 9, §5.5;
 * the port of the localStorage selection store). A saved selection is
 * validated against the backend on startup and nothing is written until that
 * settles; `shouldWriteSelection` decides every write after it, exactly as it
 * decided the localStorage writes.
 */
export type RouteSelectionState = {
  readonly selection: Selection;
  readonly load?: SelectionLoad;
  readonly changed: boolean;
  /** The path of the selection the user last asked for, written as a push. */
  readonly userPath?: string;
  readonly changeSelection: (selection: Selection) => void;
  readonly settleLoad: (load: SelectionLoad) => void;
  /** Marks the next write of `selection`'s path as the user's own. */
  readonly markUserSelection: (selection: Selection) => void;
};

let writer: RouteWriter | undefined;
/** True while the store itself navigates, so the route listener ignores it. */
let writing = false;

export const setRouteWriter = (next: RouteWriter | undefined): void => {
  writer = next;
};

export const isWritingRoute = (): boolean => writing;

const persist = (state: RouteSelectionState): Partial<RouteSelectionState> => {
  if (writer === undefined || !shouldWriteSelection(state.load, state.changed))
    return {};
  // Nothing selected and nothing changed: there is no path to write, so the
  // window keeps the one it has. That keeps a Projects path the user opened
  // directly, and equally leaves the route of another bundle (`/papercraft/…`)
  // or a path no route matches alone — an outlet that matches nothing leaves
  // its URL as it is too. A selection, or a change, still writes as before.
  if (state.selection.projectId === undefined && !state.changed) return {};
  const target =
    state.selection.projectId === undefined && writer.path() === PROJECTS_ROUTE
      ? PROJECTS_ROUTE
      : pathFor(state.selection);
  const user = state.userPath === target;
  if (writer.path() !== target) {
    writing = true;
    try {
      writer.navigate(target, { replace: !user });
    } finally {
      writing = false;
    }
  }
  return { userPath: undefined };
};

const initial = {
  selection: {},
  load: undefined,
  changed: false,
  userPath: undefined,
} satisfies Partial<RouteSelectionState>;

export const routeSelectionStore = createStore<RouteSelectionState>()(
  (set, get) => {
    const commit = (next: Partial<RouteSelectionState>): void => {
      set(next);
      set(persist(get()));
    };
    return {
      ...initial,
      changeSelection: (selection) => commit({ selection, changed: true }),
      settleLoad: (load) => commit({ load }),
      markUserSelection: (selection) => set({ userPath: pathFor(selection) }),
    };
  },
);

/**
 * Replaces a path that cannot be used with the selected or supplied fallback,
 * so the invalid history entry is not kept.
 */
export const rewriteRoute = (
  selection: Selection = routeSelectionStore.getState().selection,
): void => {
  const target = pathFor(selection);
  if (writer === undefined || writer.path() === target) return;
  writing = true;
  try {
    writer.navigate(target, { replace: true });
  } finally {
    writing = false;
  }
};

/** Back to the state of a window that has not restored anything (tests, deactivation). */
export const resetRouteSelection = (): void => {
  routeSelectionStore.setState(initial);
};

/**
 * The selection a window saved before stage 9: `localStorage['doric.selection']`
 * of the `doric://app` origin, which the platform copied from the old origin.
 */
export interface LegacySelection {
  read(): string | null;
  remove(): void;
}

/** The window's storage, when there is one (absent outside a window). */
interface WindowStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

const storage = (): WindowStorage | undefined =>
  (globalThis as { readonly localStorage?: WindowStorage }).localStorage;

export const browserLegacySelection: LegacySelection = {
  read: () => {
    try {
      return storage()?.getItem(selectionStorageKey) ?? null;
    } catch {
      return null;
    }
  },
  remove: () => {
    try {
      storage()?.removeItem(selectionStorageKey);
    } catch {
      // Storage that cannot be written keeps the old record; it is read only
      // at `/`, where the restore it causes is the one the user had.
    }
  },
};

export type RestoreOptions = {
  /** The route the window opened at. */
  readonly route: RouteMatch | undefined;
  readonly legacy: LegacySelection;
  readonly lookup: (threadId: string) => Promise<Thread | undefined>;
  /** False once the surface that started the restore is gone. */
  readonly isActive: () => boolean;
  /** False once the user acted while the lookup was pending. */
  readonly isCurrent: () => boolean;
  /** May resolve a child to its main Thread; null discards a superseded restore. */
  readonly onRestore: (
    thread: Thread,
  ) => Selection | null | undefined | Promise<Selection | null | undefined>;
  /** Picks the Project fallback after a direct Thread link resolves as deleted. */
  readonly onMissingProject: (projectId: string) => Selection;
};

/**
 * The startup restore (rule 1): the route's Thread, else at `/` the legacy
 * record, is looked up; a Thread that still exists is selected unless the user
 * acted first. The load then settles — `none`, `restored` (found or not) or
 * `failed` — and the store writes the path that selection has. The legacy
 * record is removed when that settle writes (`none`, `restored`). A `failed`
 * lookup leaves it alone, as it left the stored copy before stage 9, so the
 * next launch at `/` retries; it is removed once a later change is written.
 * A route naming no Thread after the load has settled commits nothing, so a
 * view mounted later leaves the load and the path to its own route.
 */
export const startRestore = ({
  route,
  legacy,
  lookup,
  isActive,
  isCurrent,
  onRestore,
  onMissingProject,
}: RestoreOptions): void => {
  const store = routeSelectionStore.getState();
  const legacyValue = legacy.read();
  const stored =
    routeThread(route)?.threadId ??
    (route?.pattern === WORKSPACE_ROUTE
      ? parseSelection(legacyValue)?.selectedThreadId
      : undefined);
  const settle = (load: SelectionLoad) => {
    store.settleLoad(load);
    if (legacyValue === null) return;
    if (load !== 'failed') {
      legacy.remove();
      return;
    }
    const unsubscribe = routeSelectionStore.subscribe((state) => {
      if (!shouldWriteSelection(state.load, state.changed)) return;
      unsubscribe();
      legacy.remove();
    });
  };
  if (stored === undefined) {
    if (store.load === undefined) settle('none');
    return;
  }
  void lookup(stored).then(
    async (thread) => {
      if (!isActive()) return;
      // A user who acted while restoration was pending owns the newer state.
      if (isCurrent()) {
        if (thread !== undefined) {
          let restored: Selection | null | undefined;
          try {
            restored = await onRestore(thread);
          } catch {
            if (isActive()) settle('failed');
            return;
          }
          if (!isActive()) return;
          if (restored !== null) {
            routeSelectionStore.setState({
              selection: restored ?? {
                projectId: thread.projectId,
                threadId: thread.id,
              },
              changed: true,
            });
          }
        } else {
          const projectId = routeThread(route)?.projectId;
          if (projectId !== undefined) {
            routeSelectionStore.setState({
              selection: onMissingProject(projectId),
              changed: true,
            });
          }
        }
      }
      settle('restored');
    },
    () => {
      if (!isActive()) return;
      settle('failed');
    },
  );
};
