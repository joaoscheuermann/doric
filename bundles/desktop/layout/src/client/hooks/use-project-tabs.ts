import { NavigationV1 } from 'bundle/contracts';
import { useEffect, useState } from 'react';

import {
  closeProjectTabs,
  emptyProjectTabs,
  type ProjectTabs,
  parseProjectTabs,
  projectIdFromPath,
  reconcileProjectTabs,
  rememberPath,
} from '../domain/project-tabs.js';
import type { Project } from '../domain/workspace.js';
import { layoutServices } from '../services/layout-services.js';

const key = 'doric.project-tabs';

const read = (): ProjectTabs => {
  try {
    return parseProjectTabs(localStorage.getItem(key));
  } catch {
    return emptyProjectTabs;
  }
};

export const useProjectTabs = (
  projects: readonly Project[],
  loaded: boolean,
) => {
  const navigation = layoutServices().use(NavigationV1);
  const [state, setState] = useState(read);
  const [path, setPath] = useState(() => navigation.current()?.path ?? '/');

  useEffect(() => {
    const onRoute = () => {
      const next = navigation.current()?.path ?? '/';
      setPath(next);
      setState((current) => rememberPath(current, next));
    };
    const subscription = navigation.subscribe(onRoute);
    onRoute();
    return () => subscription.dispose();
  }, [navigation]);

  useEffect(() => {
    if (!loaded) return;
    setState((current) =>
      reconcileProjectTabs(
        current,
        new Set(projects.map((project) => project.id)),
      ),
    );
  }, [projects, loaded]);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Tabs remain usable in memory when the origin's storage is unavailable.
    }
  }, [state]);

  const navigate = (target: string) => {
    setState((current) => rememberPath(current, target));
    navigation.navigate(target);
  };
  const closeMany = (ids: readonly string[]) => {
    const activeId = projectIdFromPath(path);
    const index = activeId ? state.order.indexOf(activeId) : -1;
    const next = closeProjectTabs(state, ids);
    setState(next);
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
    setState({ ...state, order });
  };
  return { state, path, navigate, close, closeMany, move };
};
