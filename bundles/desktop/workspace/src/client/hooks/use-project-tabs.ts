import { NavigationV1 } from 'bundle/contracts';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand/react';

import {
  closeProjectTabs,
  type ProjectTabs,
  projectIdFromPath,
  reconcileProjectTabs,
  rememberPath,
} from '../domain/project-tabs.js';
import type { Project } from '../domain/workspace.js';
import { workspaceServices } from '../services/workspace-services.js';
import { projectTabsKey, projectTabsStore } from '../stores/project-tabs.js';

const update = (change: (current: ProjectTabs) => ProjectTabs): void =>
  projectTabsStore.setState((state) => ({ tabs: change(state.tabs) }));

/**
 * The window's Project tabs (`stores/project-tabs.ts`): the hook follows the
 * route while it is mounted, reconciles the tabs with the loaded Projects and
 * writes them to the window's storage. `workspace-project-tabs`, which both
 * forms draw, is the one element that mounts it.
 */
export const useProjectTabs = (
  projects: readonly Project[],
  loaded: boolean,
) => {
  const navigation = useMemo(() => workspaceServices().use(NavigationV1), []);
  const state = useStore(projectTabsStore, (current) => current.tabs);
  const path = useStore(projectTabsStore, (current) => current.path);

  useEffect(() => {
    const onRoute = () => {
      const next = navigation.current()?.path ?? '/';
      projectTabsStore.setState((current) => ({
        path: next,
        tabs: rememberPath(current.tabs, next),
      }));
    };
    const subscription = navigation.subscribe(onRoute);
    onRoute();
    return () => subscription.dispose();
  }, [navigation]);

  useEffect(() => {
    if (!loaded) return;
    update((current) =>
      reconcileProjectTabs(
        current,
        new Set(projects.map((project) => project.id)),
      ),
    );
  }, [projects, loaded]);

  useEffect(() => {
    try {
      localStorage.setItem(projectTabsKey, JSON.stringify(state));
    } catch {
      // Tabs remain usable in memory when the origin's storage is unavailable.
    }
  }, [state]);

  const navigate = (target: string) => {
    update((current) => rememberPath(current, target));
    navigation.navigate(target);
  };
  const closeMany = (ids: readonly string[]) => {
    const activeId = projectIdFromPath(path);
    const index = activeId ? state.order.indexOf(activeId) : -1;
    const next = closeProjectTabs(state, ids);
    update(() => next);
    if (activeId && ids.includes(activeId)) {
      const neighbor = next.order[Math.min(index, next.order.length - 1)];
      navigate(neighbor ? next.paths[neighbor] : '/projects');
    }
  };
  const close = (id: string) => closeMany([id]);
  const move = (from: string, to: string) => {
    const order = [...state.order];
    const source = order.indexOf(from);
    const target = order.indexOf(to);
    if (source < 0 || target < 0) return;
    order.splice(source, 1);
    order.splice(target, 0, from);
    update(() => ({ ...state, order }));
  };
  return { state, path, navigate, close, closeMany, move };
};
