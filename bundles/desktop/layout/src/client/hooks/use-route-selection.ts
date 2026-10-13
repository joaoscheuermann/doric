import { useQueryClient } from '@tanstack/react-query';
import { NavigationV1, type RouteMatch } from 'bundle/contracts';
import { useEffect, useRef } from 'react';

import type { Selection } from '../domain/project-tree.js';
import { PROJECT_ROUTE, PROJECTS_ROUTE } from '../domain/route-selection.js';
import type { Thread } from '../domain/workspace.js';
import { queryKeys } from '../queries/keys.js';
import { layoutServices } from '../services/layout-services.js';
import {
  browserLegacySelection,
  isWritingRoute,
  routeSelectionStore,
  setRouteWriter,
  startRestore,
} from '../stores/route-selection.js';

export type RouteSelectionOptions = {
  readonly isCurrent: () => boolean;
  readonly onRestore: (
    thread: Thread,
  ) => Selection | null | undefined | Promise<Selection | null | undefined>;
  readonly onMissingProject: (projectId: string) => Selection;
  readonly get: (id: string) => Promise<Thread | undefined>;
  /** A navigation the layout did not make: back, forward, a link. */
  readonly onRoute: (match: RouteMatch | undefined) => void;
};

export type RouteSelection = {
  readonly changeSelection: (selection: Selection) => void;
  readonly markUserSelection: (selection: Selection) => void;
};

/**
 * Owns the selected Thread's persistence in the window path (stage 9, §5.5).
 * The path the window opened at, else the legacy saved selection, is
 * validated against the backend on startup; until that settles nothing is
 * written. Every later selection is written to the path — pushed when the
 * user made it, replaced otherwise — and a navigation the layout did not make
 * is handed to `onRoute`.
 */
export const useRouteSelection = ({
  isCurrent,
  onRestore,
  onMissingProject,
  get,
  onRoute,
}: RouteSelectionOptions): RouteSelection => {
  const queryClient = useQueryClient();
  /**
   * Read when the fetch settles rather than captured at mount: the restore
   * runs once, but a later render's callbacks carry the current selection
   * intent, so they are the ones the settled lookup must consult.
   */
  const options = useRef({
    get,
    isCurrent,
    onRestore,
    onMissingProject,
    onRoute,
  });
  options.current = { get, isCurrent, onRestore, onMissingProject, onRoute };

  useEffect(() => {
    let active = true;
    const navigation = layoutServices().use(NavigationV1);
    setRouteWriter({
      path: () => navigation.current()?.path,
      navigate: (path, { replace }) => navigation.navigate(path, { replace }),
    });
    const subscription = navigation.subscribe((match) => {
      if (!isWritingRoute()) options.current.onRoute(match);
    });
    startRestore({
      route: navigation.current(),
      legacy: browserLegacySelection,
      lookup: (threadId) =>
        queryClient.fetchQuery({
          queryKey: queryKeys.thread(threadId),
          queryFn: () => options.current.get(threadId),
        }),
      isActive: () => active,
      isCurrent: () => options.current.isCurrent(),
      onRestore: (thread) => options.current.onRestore(thread),
      onMissingProject: (projectId) =>
        options.current.onMissingProject(projectId),
    });
    const initial = navigation.current();
    if (
      initial?.pattern === PROJECT_ROUTE ||
      initial?.pattern === PROJECTS_ROUTE
    )
      options.current.onRoute(initial);
    return () => {
      active = false;
      subscription.dispose();
      setRouteWriter(undefined);
    };
  }, [queryClient.fetchQuery]);

  const state = routeSelectionStore.getState();
  return {
    changeSelection: state.changeSelection,
    markUserSelection: state.markUserSelection,
  };
};
