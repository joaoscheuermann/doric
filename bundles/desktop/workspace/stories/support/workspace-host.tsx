// The workspace bound to the fake host for one story or test: the stores
// start over, the fixture's seeds go in, `activate` runs with the fake
// services, and the children render once all of it is in place. Leaving runs
// the activation's cleanup, so the next story starts from nothing. Written
// from the layout's `layout-host.tsx` (bundle isolation 4(c)).

import { type ReactNode, useLayoutEffect, useState } from 'react';

import { projectIdFromPath } from '../../src/client/domain/project-tabs.js';
import {
  emptyTree,
  type ProjectTree,
  withSelection,
} from '../../src/client/domain/project-tree.js';
import { emptySidebar } from '../../src/client/domain/sidebar.js';
import { mainThreadFor } from '../../src/client/domain/thread-navigation.js';
import type { Project } from '../../src/client/domain/workspace.js';
import { activate } from '../../src/client/index.js';
import { addThreadRows } from '../../src/client/stores/thread-rows.js';
import { workspaceStore } from '../../src/client/stores/workspace.js';
import {
  createFakeHost,
  type FakeHost,
  type HostOptions,
} from './fake-host.js';

export interface WorkspaceFixture extends HostOptions {
  /** The Project tabs a reader left open, in order (`doric.project-tabs`). */
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

/**
 * The tree the workspace already holds when the story opens: every Project
 * with its Threads described, and the path's selection (a child Thread's root,
 * as the workspace selects it). A story whose Projects are still loading or
 * fail starts from the empty tree instead.
 */
const treeOf = (fixture: WorkspaceFixture): ProjectTree | undefined => {
  const unready = [...(fixture.pending ?? []), ...(fixture.failing ?? [])];
  if (fixture.projects === undefined || unready.includes('projects'))
    return undefined;
  const threads = fixture.threads ?? [];
  const tree: ProjectTree = {
    ...emptyTree,
    projects: fixture.projects,
    threadsByProject: Object.fromEntries(
      fixture.projects.map((project) => [
        project.id,
        threads.filter((thread) => thread.projectId === project.id),
      ]),
    ),
  };
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
 * Starts the stores over, seeds them from `fixture` and activates the
 * workspace on a fake host built from it. Returns the unbind, which runs the
 * activation's cleanup once; binding again first unbinds what is bound.
 */
export const bindWorkspace = (
  fixture: WorkspaceFixture,
): FakeHost & {
  readonly unbind: () => void;
} => {
  unbindCurrent?.();
  const created = createFakeHost(fixture);
  const tree = treeOf(fixture);
  workspaceStore.setState({
    tree: tree ?? emptyTree,
    sidebar: emptySidebar,
    loadingProjects: tree === undefined,
    loadingProjectThreads: new Set(),
    requested: new Set(Object.keys(tree?.threadsByProject ?? {})),
    connected: false,
  });
  seedProjectTabs(fixture.projectTabs);

  const deactivate = activate({ services: created.services });
  const counts = fixture.terminalRows ?? {};
  const busySet = new Set(fixture.terminalBusy);
  // The terminal bundle's rows, as it adds them through `workspace.sidebar/v1`.
  const rows = addThreadRows({
    id: 'terminals',
    tag: 'terminal-rows',
    count: (threadId) => counts[threadId] ?? 0,
    busy: (threadId) => busySet.has(threadId),
    subscribe: () => ({ dispose: () => undefined }),
  });

  const unbind = () => {
    if (unbindCurrent !== unbind) return;
    unbindCurrent = undefined;
    rows.dispose();
    void deactivate();
  };
  unbindCurrent = unbind;
  return { ...created, unbind };
};

const noFixture: WorkspaceFixture = {};

/**
 * Binds the workspace to a fake host built from `fixture`, then renders. Pass
 * a fixture defined once (module scope), not a literal built on every render.
 */
export function WorkspaceHost({
  fixture = noFixture,
  children,
}: {
  readonly fixture?: WorkspaceFixture;
  readonly children: ReactNode;
}) {
  const [host, setHost] = useState<FakeHost>();

  useLayoutEffect(() => {
    const bound = bindWorkspace(fixture);
    setHost(bound);
    return () => {
      setHost(undefined);
      bound.unbind();
    };
  }, [fixture]);

  return host === undefined ? null : children;
}
