// A fake host for the layout stories: the services `activate` binds the
// layout to, answered in memory from story data. Projects and Threads can be
// created, renamed, colored and deleted; an operation can be held pending or
// made to fail, which is how the loading and error states are drawn. The
// services the layout itself provides (`layout.tabs/v1` and the rest) are
// kept and answered in process, so a child Thread still opens its tab.

import type { ComponentProps } from 'react';

import type { RuntimeHost, ThreadsHost } from '../../src/client/api/host.js';
import type { ProjectPanel } from '../../src/client/components/organisms/project-panel.js';
import type { ConnectionStatus } from '../../src/client/domain/connection.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { activate } from '../../src/client/index.js';
import type { StackPane, ThreadRows } from '../../src/contracts/index.js';
import { placeholderElement } from './placeholder.js';

export type { StackPane, ThreadRows };

export type Services = Parameters<typeof activate>[0]['services'];

/** A `regions/v1` entry, as the panel and the region stand-ins read it. */
export type RegionEntry = ComponentProps<typeof ProjectPanel>['items'][number];

export type RegionItem = Omit<RegionEntry, 'owner'> & {
  readonly owner?: string;
};

type ProjectActivity = Awaited<
  ReturnType<RuntimeHost['projectActivity']>
>[number];

/** The host reads a story can hold pending or make fail. */
export type HostOperation = 'projects' | 'activity' | 'threads' | 'thread';

export interface HostOptions {
  readonly projects?: readonly Project[];
  readonly threads?: readonly Thread[];
  /** The window path the story opens at. */
  readonly path?: string;
  readonly connection?: ConnectionStatus;
  /** The items other bundles added to each region. */
  readonly regions?: Readonly<Record<string, readonly RegionItem[]>>;
  /** Reads that never answer, for loading states. */
  readonly pending?: readonly HostOperation[];
  /** Reads that fail as an unreachable host does. */
  readonly failing?: readonly HostOperation[];
  /** How many terminal rows each Thread has in the sidebar tree. */
  readonly terminalRows?: Readonly<Record<string, number>>;
}

const terminalCommands = ['npm run dev', 'npm test -- --watch', 'tsc --watch'];

/**
 * The terminal bundle's rows under one Thread: one row per terminal, none
 * when the Thread has no terminal, as `<terminal-rows thread-id>` draws them.
 */
const terminalRowsElement = (count: number): HTMLElement => {
  const element = document.createElement('div');
  element.style.display = 'contents';
  element.append(
    ...Array.from({ length: count }, (_, index) =>
      placeholderElement(
        'terminal-rows',
        undefined,
        `Terminal · ${terminalCommands[index % terminalCommands.length]}`,
      ),
    ),
  );
  return element;
};

/** The region items the running app adds, by the bundles that add them. */
export const appRegions: Readonly<Record<string, readonly RegionItem[]>> = {
  'layout.panel': [
    {
      id: 'files',
      tag: 'files-tree',
      order: 100,
      owner: 'files',
      props: { label: 'Files', icon: 'files' },
    },
    {
      id: 'changes',
      tag: 'git-changes',
      order: 200,
      owner: 'git',
      props: {
        label: 'Changes',
        icon: 'file-diff',
        badgeTag: 'git-changes-badge',
      },
    },
  ],
  'layout.header': [
    {
      id: 'terminal-new',
      tag: 'terminal-new-button',
      order: 10,
      owner: 'terminal',
    },
  ],
  'layout.footer': [
    { id: 'git-cwd', tag: 'git-workspace-cwd', order: 10, owner: 'git' },
    { id: 'usage', tag: 'usage-summary', order: 30, owner: 'usage' },
  ],
  'layout.global-footer': [
    {
      id: 'resources',
      tag: 'resources-monitor',
      order: 100,
      owner: 'resources',
    },
  ],
  'layout.main.bottom': [
    { id: 'terminals', tag: 'terminal-panel', owner: 'terminal' },
  ],
};

/** The Screens group the screen bundle adds below the Threads tree. */
export const screenPane: StackPane = {
  id: 'screen-sidebar',
  order: 10,
  title: 'Screens',
  tag: 'screen-sidebar',
  headerTag: 'screen-group-action',
  collapsible: true,
  initiallyOpen: false,
  minSize: '20%',
  maxSize: '80%',
};

type RouteMatch = {
  readonly path: string;
  readonly pattern: string;
  readonly params: Record<string, string>;
};

const patterns = [
  '/',
  '/projects',
  '/projects/:projectId',
  '/projects/:projectId/threads/:threadId',
];

/** The route the window's navigation would match for `path`. */
const matchPath = (path: string): RouteMatch | undefined => {
  const parts = path.split('/').filter(Boolean);
  for (const pattern of patterns) {
    const keys = pattern.split('/').filter(Boolean);
    if (keys.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matches = keys.every((key, index) => {
      const part = parts[index] ?? '';
      if (key.startsWith(':')) {
        params[key.slice(1)] = decodeURIComponent(part);
        return true;
      }
      return key === part;
    });
    if (matches) return { path, pattern, params };
  }
  return undefined;
};

const disposable = { dispose: () => undefined };

const never = <Value>(): Promise<Value> => new Promise<Value>(() => undefined);

type Method = {
  readonly input?: { readonly def?: { readonly type?: string } };
  readonly execute: (
    input: unknown,
    call: unknown,
    services: unknown,
  ) => unknown;
};

type Definition = {
  readonly id: string;
  readonly methods: Readonly<Record<string, Method>>;
};

export interface FakeHost {
  readonly services: Services;
  /** The items of a region, the same array until the story ends. */
  regionItems(region: string): readonly RegionEntry[];
}

export const createFakeHost = (options: HostOptions = {}): FakeHost => {
  let projects = [...(options.projects ?? [])];
  let threads = [...(options.threads ?? [])];
  const pending = new Set(options.pending ?? []);
  const failing = new Set(options.failing ?? []);

  /** Answers a read, holds it, or fails it as the story asked. */
  const read = <Value>(
    operation: HostOperation,
    answer: () => Value,
  ): Promise<Value> => {
    if (pending.has(operation)) return never();
    if (failing.has(operation)) {
      return Promise.reject(new Error('The host is unreachable.'));
    }
    return Promise.resolve(answer());
  };

  const now = () => new Date().toISOString();
  const updateProject = (
    id: string,
    change: (project: Project) => Project,
  ): Project | undefined => {
    const current = projects.find((candidate) => candidate.id === id);
    if (current === undefined) return undefined;
    const next = { ...change(current), updatedAt: now() };
    projects = projects.map((candidate) =>
      candidate.id === id ? next : candidate,
    );
    return next;
  };
  const updateThread = (
    id: string,
    change: (thread: Thread) => Thread,
  ): Thread | undefined => {
    const current = threads.find((candidate) => candidate.id === id);
    if (current === undefined) return undefined;
    const next = { ...change(current), updatedAt: now() };
    threads = threads.map((candidate) =>
      candidate.id === id ? next : candidate,
    );
    return next;
  };
  const activity = (): readonly ProjectActivity[] =>
    projects
      .map((project) => {
        const latest = threads
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => thread.updatedAt)
          .concat(project.updatedAt)
          .sort()
          .at(-1);
        return { project, activityAt: latest ?? project.updatedAt };
      })
      .sort((left, right) => right.activityAt.localeCompare(left.activityAt));

  const runtime: RuntimeHost = {
    projects: () => read('projects', () => ({ items: projects })),
    projectActivity: () => read('activity', activity),
    createProject: ({ name }) => {
      const project: Project = {
        id: crypto.randomUUID(),
        name,
        state: 'ready',
        configRevision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      projects = [project, ...projects];
      return Promise.resolve(project);
    },
    renameProject: ({ id, name }) =>
      Promise.resolve(updateProject(id, (project) => ({ ...project, name }))),
    setProjectColor: ({ id, color }) =>
      Promise.resolve(
        updateProject(id, ({ color: _previous, ...project }) =>
          color === null ? project : { ...project, color },
        ),
      ),
    terminateProject: (id) =>
      Promise.resolve(updateProject(id, (project) => project)),
    deleteProject: (id) => {
      projects = projects.filter((project) => project.id !== id);
      threads = threads.filter((thread) => thread.projectId !== id);
      return Promise.resolve('deleted');
    },
    watchProject: () => disposable,
  };

  const threadsHost: ThreadsHost = {
    threads: ({ projectId }) =>
      read('threads', () =>
        projects.some((project) => project.id === projectId)
          ? {
              items: threads.filter((thread) => thread.projectId === projectId),
            }
          : undefined,
      ),
    thread: (id) =>
      read('thread', () => threads.find((thread) => thread.id === id)),
    createThread: ({ projectId, name, parentThreadId }) => {
      const thread: Thread = {
        id: crypto.randomUUID(),
        projectId,
        ...(parentThreadId === undefined ? {} : { parentThreadId }),
        name,
        state: 'ready',
        lastSequence: 0,
        cwd: '/workspace',
        createdAt: now(),
        updatedAt: now(),
      };
      threads = [...threads, thread];
      return Promise.resolve({ status: 'created', thread });
    },
    renameThread: ({ id, name }) =>
      Promise.resolve(updateThread(id, (thread) => ({ ...thread, name }))),
    terminateThread: (id) =>
      Promise.resolve(updateThread(id, (thread) => thread)),
    deleteThread: (id) => {
      const removed = new Set([id]);
      for (const thread of threads) {
        if (thread.parentThreadId && removed.has(thread.parentThreadId))
          removed.add(thread.id);
      }
      threads = threads.filter((thread) => !removed.has(thread.id));
      return Promise.resolve('deleted');
    },
  };

  let path = options.path ?? '/';
  const routeListeners = new Set<(match: RouteMatch | undefined) => void>();
  const navigation = {
    register: () => disposable,
    navigate: (next: string) => {
      path = next;
      const match = matchPath(next);
      for (const listener of [...routeListeners]) listener(match);
    },
    back: () => undefined,
    current: () => matchPath(path),
    chain: () => [],
    subscribe: (listener: (match: RouteMatch | undefined) => void) => {
      routeListeners.add(listener);
      return { dispose: () => routeListeners.delete(listener) };
    },
  };

  const regions = new Map<string, readonly RegionEntry[]>();
  const regionItems = (region: string): readonly RegionEntry[] => {
    const known = regions.get(region);
    if (known !== undefined) return known;
    const items = Object.freeze(
      (options.regions?.[region] ?? []).map(
        ({ owner, ...item }): RegionEntry => ({
          ...item,
          owner: owner ?? 'story',
        }),
      ),
    );
    regions.set(region, items);
    return items;
  };

  const status = options.connection ?? 'connected';
  const apis: Record<string, unknown> = {
    'runtime/v1': runtime,
    'runtime.threads/v1': threadsHost,
    'doric.connection/v1': {
      status: () => status,
      subscribe: () => disposable,
    },
    'ui/v1': {
      define: () => disposable,
      create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
        const threadId = props?.['thread-id'];
        return tag === 'terminal-rows' && typeof threadId === 'string'
          ? terminalRowsElement(options.terminalRows?.[threadId] ?? 0)
          : placeholderElement(tag, props);
      },
      dispose: () => undefined,
    },
    'navigation/v1': navigation,
    'regions/v1': {
      add: () => disposable,
      items: regionItems,
      subscribe: () => disposable,
    },
    'commands/v1': {
      register: () => disposable,
      execute: (command: unknown) => {
        console.info('Story host: command executed', command);
        return Promise.resolve();
      },
    },
  };

  /** What the layout provides, answered in process. */
  const provided = new Map<string, Definition>();
  const stub = (definition: Definition) =>
    Object.fromEntries(
      Object.entries(definition.methods).map(([name, method]) => [
        name,
        (...args: unknown[]) =>
          method.execute(
            method.input?.def?.type === 'tuple' ? args : args[0],
            {},
            services,
          ),
      ]),
    );

  const services = {
    provide: (definition: Definition) => {
      provided.set(definition.id, definition);
      return {
        dispose: () => {
          if (provided.get(definition.id) === definition)
            provided.delete(definition.id);
        },
      };
    },
    use: (contract: { readonly id: string }) => {
      const own = provided.get(contract.id);
      if (own !== undefined) return stub(own);
      const api = apis[contract.id];
      if (api === undefined) {
        throw new Error(`The story host does not provide "${contract.id}".`);
      }
      return api;
    },
    whenAvailable: () => disposable,
  } as unknown as Services;

  return { services, regionItems };
};
