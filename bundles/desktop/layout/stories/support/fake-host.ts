// A fake host for the layout stories: the services `activate` binds the
// layout to, answered in memory from story data. Projects and Threads can be
// created, renamed, colored and deleted; an operation can be held pending or
// made to fail, which is how the loading and error states are drawn. The
// services the layout itself provides (`layout.tabs/v1` and the rest) are
// kept and answered in process, so a child Thread still opens its tab.

import type { DoricAbout, Navigation, ProviderInfo } from 'bundle/contracts';
import { type ComponentProps, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { RuntimeHost, ThreadsHost } from '../../src/client/api/host.js';
import type { ProjectPanel } from '../../src/client/components/organisms/project-panel.js';
import type { ConnectionStatus } from '../../src/client/domain/connection.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { activate } from '../../src/client/index.js';
import type { StackPane, ThreadRows } from '../../src/contracts/index.js';
import { placeholderElement } from './placeholder.js';
import { type FixtureTerminal, TerminalRowsFixture } from './terminal-rows.js';

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
  /**
   * Contract ids the host does not provide, as an older app lacks a platform
   * contract. For an id listed here:
   * - `services.use` throws, as it does for any id the host does not know;
   * - `services.whenAvailable` never calls back.
   * Wins over the host's own answers and over what the layout provides.
   */
  readonly absent?: readonly string[];
}

const terminalCommands = ['npm run dev', 'npm test -- --watch', 'tsc --watch'];

/** One fixture terminal per row: the reader's first, then the agent's runs. */
const fixtureTerminals = (count: number): readonly FixtureTerminal[] =>
  Array.from({ length: count }, (_, index) => {
    const command = terminalCommands[index % terminalCommands.length] ?? '';
    const agent = index % 2 === 1;
    return {
      id: `terminal-${index}`,
      label: agent ? `${command} · 00:12 (10:00)` : command,
      origin: agent ? 'agent' : 'user',
    };
  });

/**
 * How deep a Thread's terminal rows sit: one level under a main Thread, one
 * more for each ancestor it was opened inside.
 */
const rowsDepth = (threadId: string, threads: readonly Thread[]): number => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let depth = 1;
  let thread = byId.get(threadId);
  while (thread?.parentThreadId !== undefined) {
    depth += 1;
    thread = byId.get(thread.parentThreadId);
  }
  return depth;
};

/**
 * The terminal bundle's rows under one Thread, as `<terminal-rows thread-id>`
 * draws them: one row per terminal, none when the Thread has no terminal, with
 * the app's row styling (its icon, its command, and the stop or discard button
 * that appears on hover).
 */
const terminalRowsElement = (count: number, depth: number): HTMLElement => {
  const element = document.createElement('div');
  element.style.display = 'contents';
  const root = createRoot(element);
  flushSync(() =>
    root.render(
      createElement(TerminalRowsFixture, {
        depth,
        terminals: fixtureTerminals(count),
      }),
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
    { id: 'usage', tag: 'usage-summary', order: 30, owner: 'usage' },
  ],
  'layout.panel.footer': [
    { id: 'git-cwd', tag: 'git-workspace-cwd', order: 10, owner: 'git' },
  ],
  'layout.account.status': [
    {
      id: 'resources',
      tag: 'resources-monitor',
      order: 10,
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
  /**
   * The services `activate` binds the layout to.
   *
   * `use(ref)` answers an id the layout provided, then the host's own
   * answers: `runtime/v1`, `runtime.threads/v1`, `doric.connection/v1`,
   * `doric.about/v1` (`get()` resolves `{ version: '0.0.1' }`), `ui/v1`,
   * `navigation/v1`, `regions/v1` and `commands/v1`. It throws for an id in
   * `absent` or unknown.
   *
   * `whenAvailable(ref, callback)` behaves as follows:
   * - for an id `use` would answer, it calls `callback(api, provider)` once,
   *   synchronously, with the same api `use` returns;
   * - for an absent or unknown id it never calls back;
   * - it does not call back for providers added later;
   * - disposing the returned disposable runs the callback's cleanup, if the
   *   callback returned one, at most once.
   */
  readonly services: Services;
  /** The items of a region, the same array until the story ends. */
  regionItems(region: string): readonly RegionEntry[];
  /**
   * The ids of the commands executed through `commands/v1` so far, in order.
   * A ref is recorded by its `id`. Each call returns a new array, and later
   * executions do not change an array already returned.
   */
  executed(): readonly string[];
}

/** The provider a story host's `whenAvailable` callback is bound to. */
const storyProvider: ProviderInfo = { bundleId: 'story', version: '0.0.0' };

/** The id `commands/v1.execute` was given: a contract id, or a ref's `id`. */
const commandId = (command: unknown): string =>
  typeof command === 'string'
    ? command
    : String((command as { readonly id?: unknown } | undefined)?.id);

export const createFakeHost = (options: HostOptions = {}): FakeHost => {
  let projects = [...(options.projects ?? [])];
  let threads = [...(options.threads ?? [])];
  const pending = new Set(options.pending ?? []);
  const failing = new Set(options.failing ?? []);
  const absent = new Set(options.absent ?? []);
  const commandsExecuted: string[] = [];

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
    forward: () => undefined,
    history: () => ({ canGoBack: false, canGoForward: false }),
    current: () => matchPath(path),
    chain: () => [],
    subscribe: (listener: (match: RouteMatch | undefined) => void) => {
      routeListeners.add(listener);
      return { dispose: () => routeListeners.delete(listener) };
    },
  } satisfies Navigation;

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
    'doric.about/v1': {
      get: () => Promise.resolve({ version: '0.0.1' }),
    } satisfies DoricAbout,
    'ui/v1': {
      define: () => disposable,
      create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
        const threadId = props?.['thread-id'];
        return tag === 'terminal-rows' && typeof threadId === 'string'
          ? terminalRowsElement(
              options.terminalRows?.[threadId] ?? 0,
              rowsDepth(threadId, options.threads ?? []),
            )
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
        commandsExecuted.push(commandId(command));
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

  /** What `use` answers for `id`, or `undefined` where it throws. */
  const answer = (id: string): unknown => {
    if (absent.has(id)) return undefined;
    const own = provided.get(id);
    if (own !== undefined) return stub(own);
    return apis[id];
  };

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
      const api = answer(contract.id);
      if (api === undefined) {
        throw new Error(`The story host does not provide "${contract.id}".`);
      }
      return api;
    },
    whenAvailable: (
      contract: { readonly id: string },
      callback: (
        api: unknown,
        provider: ProviderInfo,
      ) => undefined | (() => unknown),
    ) => {
      const api = answer(contract.id);
      if (api === undefined) return disposable;
      const cleanup = callback(api, storyProvider);
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  } as unknown as Services;

  const executed = (): readonly string[] => [...commandsExecuted];

  return { services, regionItems, executed };
};
