// The git client as a story sees it: a store over a fake `GitApi` (fixture
// answers, no host), set as the window's git client before its children
// render, under the providers the bundle's elements wrap every surface in
// (`elements.tsx`): its query client, a tooltip provider and the sidebar
// scope. The workspace selection, tabs, panel and commands are fakes too.

import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { SidebarScope } from 'desktop/ui/sidebar';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, useState } from 'react';
import type { Project, Thread } from 'runtime/contracts';

import type { GitApi } from '../../src/client/api/git-api.js';
import type { TreeObservation } from '../../src/client/api/peers.js';
import {
  createGitStore,
  type GitStore,
} from '../../src/client/changes/store.js';
import { comparisonTabId } from '../../src/client/commands.js';
import { gitClient, setGitClient } from '../../src/client/state.js';
import type { ProjectChangesResult } from '../../src/contracts/index.js';
import {
  branches,
  changes,
  notRepository,
  project,
  thread,
} from './fixtures.js';
import { fakeServices, still } from './services.js';

/** A promise that never settles: a read still on its way. */
export const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

/** A read that fails with the sentence the host's route answers. */
export const failing = <T,>(message: string): Promise<T> =>
  Promise.reject(new Error(message));

/** A `GitApi` answering fixtures; each story overrides what it shows. */
export const fakeGitApi = (answers: Partial<GitApi> = {}): GitApi => ({
  changes: async (): Promise<ProjectChangesResult> => ({
    status: 'ready',
    changes,
  }),
  fileDiff: async () => ({ status: 'not_found' }),
  git: async () => notRepository,
  branches: async () => branches,
  switchBranch: async () => branches,
  ...answers,
});

/** Makes `store` the window's git client, as the activation does. */
const bind = (store: GitStore): void => {
  if (gitClient()?.store !== store)
    setGitClient({ store, refresh: () => undefined });
};

/** The git client's providers over a fake API. */
export function GitHarness({
  api,
  children,
}: {
  readonly api: GitApi;
  readonly children?: ReactNode;
}) {
  const [store] = useState(() => createGitStore(() => api));
  // Before the children render: `ChangesView` reads the client while
  // rendering and the hooks read it in their (earlier-running) effects.
  bind(store);
  return (
    <QueryClientProvider client={store.client}>
      <TooltipProvider>
        <SidebarScope>{children}</SidebarScope>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** Binds a store made outside a harness (the elements story's). */
export const bindStore = bind;

export interface WindowFixture {
  readonly project?: Project;
  readonly thread?: Thread;
  /** The open comparison tab, whose row the Changes view selects. */
  readonly comparing?: { readonly repository: string; readonly path: string };
  /** The files tree read the Changes view is gated by; absent: no files bundle. */
  readonly tree?: TreeObservation;
  /** The settings window's draft and the stored credentials. */
  readonly settings?: {
    readonly draft: Readonly<Record<string, unknown>>;
    readonly credentials: readonly unknown[];
  };
}

/** The tree read of a ready sandbox. */
export const readyTree: TreeObservation = {
  read: { status: 'ready', value: [] },
  fetching: false,
};

/** The window peers the git surfaces read, over fixtures. */
export const windowServices = (fixture: WindowFixture = {}): Services => {
  const { comparing, tree, settings } = fixture;
  // An explicit `undefined` is a window with nothing selected.
  const selectedProject = 'project' in fixture ? fixture.project : project;
  const selectedThread = 'thread' in fixture ? fixture.thread : thread;
  const selection = {
    ...(selectedProject === undefined ? {} : { project: selectedProject }),
    ...(selectedThread === undefined ? {} : { thread: selectedThread }),
  };
  let draft = settings?.draft;
  const listeners = new Set<() => void>();
  return fakeServices({
    'layout.workspace/v1': {
      selection: () => selection,
      subscribe: still,
    },
    'layout.tabs/v1': {
      current: () =>
        comparing === undefined || selectedProject === undefined
          ? undefined
          : {
              id: comparisonTabId({
                projectId: selectedProject.id,
                ...comparing,
              }),
            },
      subscribe: still,
    },
    'layout.panel/v1': { show: () => undefined, subscribe: still },
    'commands/v1': { execute: async () => undefined },
    ...(tree === undefined
      ? {}
      : {
          'files.sandbox/v1': {
            observeTree: (
              _scope: unknown,
              listener: (state: TreeObservation) => void,
            ) => {
              listener(tree);
              return { dispose: () => undefined };
            },
          },
        }),
    ...(settings === undefined
      ? {}
      : {
          'settings.config/v1': {
            draft: () => draft,
            setDraft: (
              update: (
                current: Readonly<Record<string, unknown>>,
              ) => Record<string, unknown>,
            ) => {
              draft = update(draft ?? {});
              for (const listener of listeners) listener();
            },
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return { dispose: () => listeners.delete(listener) };
            },
          },
          'secrets/v1': { list: async () => settings.credentials },
        }),
  });
};
