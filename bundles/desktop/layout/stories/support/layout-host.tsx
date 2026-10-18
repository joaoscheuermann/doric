// The layout bound to the fake host for one story: the stores start over,
// the story's seeds go in, `activate` runs with the fake services, and the
// children render once all of it is in place. Leaving the story runs the
// activation's cleanup, so the next story starts from nothing.

import { type ReactNode, useLayoutEffect, useState } from 'react';

import { projectIdFromPath } from '../../src/client/domain/project-tabs.js';
import {
  emptyTree,
  type ProjectTree,
  withProjects,
  withSelection,
  withThreads,
} from '../../src/client/domain/project-tree.js';
import { emptySidebar } from '../../src/client/domain/sidebar.js';
import { mainThreadFor } from '../../src/client/domain/thread-navigation.js';
import type { Project } from '../../src/client/domain/workspace.js';
import type { WorkspaceTab } from '../../src/client/domain/workspace-tabs.js';
import { activate } from '../../src/client/index.js';
import { bottomStore } from '../../src/client/stores/bottom.js';
import { panelStore } from '../../src/client/stores/panel.js';
import { registerPane } from '../../src/client/stores/stack.js';
import { addThreadRows } from '../../src/client/stores/thread-rows.js';
import { workspaceStore } from '../../src/client/stores/workspace.js';
import { workspaceTabsStore } from '../../src/client/stores/workspace-tabs.js';
import {
  appRegions,
  createFakeHost,
  type FakeHost,
  type HostOptions,
  type StackPane,
  screenPane,
} from './fake-host.js';
import { placeholderElement } from './placeholder.js';
import { defineStoryElements } from './story-elements.js';

/** A tab another bundle opened, drawn by a stand-in for its element. */
export interface TabSeed {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly icon?: 'file' | 'file-diff' | 'terminal' | 'thread';
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface LayoutFixture extends HostOptions {
  /** Open tabs by owner (a Thread id or `project:<id>`); the last is selected. */
  readonly tabs?: Readonly<Record<string, readonly TabSeed[]>>;
  /** The Project panel: open on Files unless a story says otherwise. */
  readonly panel?: { readonly open?: boolean; readonly active?: string };
  /** Whether an item asked for the `layout.main.bottom` split. */
  readonly bottom?: boolean;
  /** Sidebar groups other bundles add below the Threads tree. */
  readonly panes?: readonly StackPane[];
  /** The Project tabs a reader left open, in order. */
  readonly projectTabs?: readonly Project[];
}

const projectTabsKey = 'doric.project-tabs';

const seedProjectTabs = (open: readonly Project[] | undefined): void => {
  try {
    if (open === undefined) {
      localStorage.removeItem(projectTabsKey);
      return;
    }
    localStorage.setItem(
      projectTabsKey,
      JSON.stringify({
        homePath: '/',
        order: open.map((project) => project.id),
        paths: Object.fromEntries(
          open.map((project) => [project.id, `/projects/${project.id}`]),
        ),
      }),
    );
  } catch {
    // Without storage the tab strip starts from the route alone.
  }
};

const tabsOf = (
  seeds: Readonly<Record<string, readonly TabSeed[]>> | undefined,
) =>
  Object.fromEntries(
    Object.entries(seeds ?? {}).map(([owner, list]) => {
      const items = list.map(
        (seed): WorkspaceTab => ({
          kind: 'element',
          id: seed.id,
          title: seed.title,
          element: placeholderElement(seed.tag, seed.props, seed.title),
          ...(seed.props === undefined ? {} : { props: seed.props }),
          ...(seed.icon === undefined ? {} : { icon: seed.icon }),
          ariaLabel: seed.title,
          tooltip: seed.title,
        }),
      );
      return [owner, { items, selected: items.at(-1)?.id }];
    }),
  );

/**
 * The tree the workspace already holds when the story opens: every Project
 * with its Threads described, and the path's selection (a child Thread's root,
 * as the workspace selects it). A story whose Projects are still loading or
 * fail starts from the empty tree instead.
 */
const treeOf = (fixture: LayoutFixture): ProjectTree | undefined => {
  const unready = [...(fixture.pending ?? []), ...(fixture.failing ?? [])];
  if (fixture.projects === undefined || unready.includes('projects'))
    return undefined;
  const threads = fixture.threads ?? [];
  let tree = withProjects(emptyTree, fixture.projects);
  for (const project of fixture.projects) {
    tree = withThreads(
      tree,
      project.id,
      threads.filter((thread) => thread.projectId === project.id),
    );
  }
  const path = fixture.path ?? '/';
  const projectId = projectIdFromPath(path);
  if (projectId === undefined) return tree;
  const threadId = /\/threads\/([^/]+)$/.exec(path)?.[1];
  const target = threads.find((thread) => thread.id === threadId);
  const main = target === undefined ? undefined : mainThreadFor(tree, target);
  return withSelection(
    tree,
    main === undefined ? { projectId } : { projectId, threadId: main.id },
  );
};

let unbindCurrent: (() => void) | undefined;

/**
 * Starts the stores over, seeds them from `fixture` and activates the layout
 * on a fake host built from it. Returns the unbind, which runs the
 * activation's cleanup once; binding again first unbinds what is bound.
 */
export const bindLayout = (
  fixture: LayoutFixture,
): FakeHost & {
  readonly unbind: () => void;
} => {
  unbindCurrent?.();
  const created = createFakeHost({ regions: appRegions, ...fixture });
  const tree = treeOf(fixture);
  workspaceStore.setState({
    tree: tree ?? emptyTree,
    sidebar: emptySidebar,
    loadingProjects: tree === undefined,
    loadingProjectThreads: new Set(),
  });
  workspaceTabsStore.setState({ threads: tabsOf(fixture.tabs) });
  seedProjectTabs(fixture.projectTabs);
  defineStoryElements(created);

  const deactivate = activate({ services: created.services });
  const panes = (fixture.panes ?? [screenPane]).map(registerPane);
  const counts = fixture.terminalRows ?? {};
  const rows = addThreadRows({
    id: 'terminals',
    tag: 'terminal-rows',
    count: (threadId) => counts[threadId] ?? 0,
    subscribe: () => ({ dispose: () => undefined }),
  });
  panelStore.setState({
    open: fixture.panel?.open ?? true,
    active: fixture.panel?.active ?? 'files',
  });
  if (fixture.bottom) bottomStore.getState().set('terminals', true);

  const unbind = () => {
    if (unbindCurrent !== unbind) return;
    unbindCurrent = undefined;
    rows.dispose();
    for (const pane of panes) pane.dispose();
    void deactivate();
    workspaceTabsStore.setState({ threads: {} });
  };
  unbindCurrent = unbind;
  return { ...created, unbind };
};

const noFixture: LayoutFixture = {};

/**
 * Binds the layout to a fake host built from `fixture`, then renders. Pass a
 * fixture defined once (module scope), not a literal built on every render.
 */
export function LayoutHost({
  fixture = noFixture,
  children,
}: {
  readonly fixture?: LayoutFixture;
  readonly children: ReactNode;
}) {
  const [host, setHost] = useState<FakeHost>();

  useLayoutEffect(() => {
    const bound = bindLayout(fixture);
    setHost(bound);
    return () => {
      setHost(undefined);
      bound.unbind();
    };
  }, [fixture]);

  return host === undefined ? null : children;
}
