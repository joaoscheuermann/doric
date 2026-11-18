import { createStore } from 'zustand/vanilla';

import {
  emptyProjectTabs,
  type ProjectTabs,
  parseProjectTabs,
} from '../domain/project-tabs.js';

/**
 * The window's Project tabs and the path they were last told about. It lives
 * outside the elements because the navigation's slot elements are separate
 * roots: a Project opened in `layout-dashboard` shows its tab in
 * `layout-project-tabs`, and the tabs survive a change of form, which mounts
 * new elements.
 */
export type ProjectTabsState = {
  readonly tabs: ProjectTabs;
  readonly path: string;
};

/** The window storage key the tabs are kept under. */
export const projectTabsKey = 'doric.project-tabs';

export const projectTabsStore = createStore<ProjectTabsState>()(() => ({
  tabs: emptyProjectTabs,
  path: '/',
}));

/** Starts the tabs over from the window's storage, as an activation does. */
export const restoreProjectTabs = (): void => {
  let tabs = emptyProjectTabs;
  try {
    tabs = parseProjectTabs(localStorage.getItem(projectTabsKey));
  } catch {
    // Without storage the tab strip starts from the route alone.
  }
  projectTabsStore.setState({ tabs, path: '/' });
};
