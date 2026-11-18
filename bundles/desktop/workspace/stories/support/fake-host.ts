// A fake host for the workspace's stories and tests (bundle isolation 4(c),
// spec §9 support table): the services `activate` binds the workspace to,
// answered in memory from story data. Written from the layout's fake host
// (`bundles/desktop/layout/stories/support/fake-host.ts`): the same service
// registry, `ui/v1`, `regions/v1`, `navigation/v1`, `doric.connection/v1`,
// `doric.catalog/v1` and the records mirror (`runtime.records/v1`, built by
// `createRecordsApi` of `runtime/testing`). It adds what the workspace reaches
// and the layout did not:
// - `commands/v1` records each command with its input (the footer's data
//   items, as `account`'s host does);
// - `hooks/v1`, an in-memory hooks provider, so `workspace.hooks/v1` can be
//   defined and observed (decision S5);
// - recording fakes of the shell's `layout.tabs/v2` and
//   `layout.conversation/v1`, which the workspace now calls across a bundle
//   boundary.

import type {
  CatalogSnapshot,
  Disposable,
  Navigation,
  ProviderInfo,
  RegionEntry,
  Services,
} from 'bundle/contracts';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ProjectActivity, RuntimeRecords } from 'runtime/contracts';
import { createRecordsApi, type RecordsOperation } from 'runtime/testing';

import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { ThreadRows } from '../../src/contracts/index.js';
import { placeholderElement } from './placeholder.js';
import { type FixtureTerminal, TerminalRowsFixture } from './terminal-rows.js';

export type { RegionEntry, Services, ThreadRows };

/** A region item a fixture seeds; `owner` defaults to `story`. */
export type RegionItem = Omit<RegionEntry, 'owner'> & {
  readonly owner?: string;
};

/**
 * The host reads a story can hold pending or make fail; `thread` is the
 * mirror's `findThread`.
 */
export type HostOperation = 'projects' | 'activity' | 'threads' | 'thread';

export interface HostOptions {
  readonly projects?: readonly Project[];
  readonly threads?: readonly Thread[];
  /** The window path the story opens at. */
  readonly path?: string;
  readonly connection?: 'connected' | 'disconnected';
  /** The items other bundles added to each region. */
  readonly regions?: Readonly<Record<string, readonly RegionItem[]>>;
  /** Reads that never answer, for loading states. */
  readonly pending?: readonly HostOperation[];
  /** Reads that fail as an unreachable host does. */
  readonly failing?: readonly HostOperation[];
  /** How many terminal rows each Thread has in the sidebar tree. */
  readonly terminalRows?: Readonly<Record<string, number>>;
  /**
   * Thread ids with a busy agent terminal: the stories' `workspace.sidebar/v1`
   * registration answers `busy` true for them. Absent: no Thread is busy.
   */
  readonly terminalBusy?: readonly string[];
  /**
   * Contract ids the host does not provide. For an id listed here
   * `services.use` throws and `services.whenAvailable` never calls back.
   * Wins over the host's own answers and over what the workspace provides.
   */
  readonly absent?: readonly string[];
  /**
   * The bundle catalog `doric.catalog/v1` reports (`get()` answers this
   * snapshot). Absent: the host does not provide the contract.
   */
  readonly catalog?: CatalogSnapshot;
}

/** One command executed through `commands/v1`. */
export interface ExecutedCommand {
  /** The contract id, or a ref's `id`. */
  readonly command: string;
  readonly input: unknown;
}

/** One call the `layout.tabs/v2` fake received, with its input. */
export interface TabsCall {
  readonly method: 'open' | 'close' | 'focus' | 'retitle' | 'setOwner';
  readonly input: unknown;
}

/** One `layout.conversation/v1.setBottomVisible` call. */
export interface BottomCall {
  readonly itemId: string;
  readonly visible: boolean;
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

/** How deep a Thread's terminal rows sit: one level under a main Thread, one more per ancestor. */
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

/** The terminal bundle's rows under one Thread, as `<terminal-rows thread-id>` draws them. */
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

type HookDefinition = {
  readonly kind: string;
  readonly input: { parse(value: unknown): unknown };
};

type HooksContractLike = {
  readonly id: string;
  readonly hooks: Readonly<Record<string, HookDefinition>>;
};

type Handler = (input: unknown) => unknown;

/** A route registered through `navigation/v1`, as the core's outlet reads it. */
export interface RouteRegistration {
  readonly path: string;
  readonly parent?: string;
  readonly create: (match: RouteMatch) => unknown;
}

export interface FakeHost {
  /**
   * The services `activate` binds the workspace to.
   *
   * `use(ref)` answers an id the workspace provided, then the host's own
   * answers: `runtime.records/v1` (`records`), `doric.connection/v1`,
   * `doric.catalog/v1` (with `catalog`), `ui/v1`, `navigation/v1`,
   * `regions/v1`, `commands/v1`, `hooks/v1`, `layout.tabs/v2` and
   * `layout.conversation/v1`. It throws for an id in `absent` or unknown.
   * `ui/v1` creates each element defined through it under its own tag, with
   * these services and its props; any other tag is a placeholder.
   *
   * `whenAvailable(ref, callback)` calls `callback(api, provider)` once,
   * synchronously, for an id `use` would answer, and never for another;
   * disposing what it returns runs the callback's cleanup at most once.
   */
  readonly services: Services;
  /**
   * The items of a region: the fixture's, then those added through
   * `regions/v1`, whose `subscribe` hears every change. The same array until
   * the region changes.
   */
  regionItems(region: string): readonly RegionEntry[];
  /** The commands executed through `commands/v1` so far, in order; a new array each call. */
  executed(): readonly ExecutedCommand[];
  /** The calls `layout.tabs/v2` received so far, in order; a new array each call. */
  tabCalls(): readonly TabsCall[];
  /** The calls `layout.conversation/v1.setBottomVisible` received, in order. */
  bottomCalls(): readonly BottomCall[];
  /** The routes registered through `navigation/v1` and not disposed, in order. */
  routes(): readonly RouteRegistration[];
  /**
   * The object the host answers `use('runtime.records/v1')` with, the same on
   * every `use`. A test may replace its members; the workspace calls the
   * replacement.
   */
  readonly records: RuntimeRecords;
  /** Calls every listener subscribed through `records.subscribe`. */
  notifyRecords(): void;
}

/** The activity of every Project: its latest Thread or own update, newest first. */
const activityOf = (
  projects: readonly Project[],
  threads: readonly Thread[],
): readonly ProjectActivity[] =>
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

/** The mirror's name for a host read. */
const recordsOperation = (operation: HostOperation): RecordsOperation =>
  operation === 'thread' ? 'findThread' : operation;

/** The provider a story host's `whenAvailable` callback is bound to. */
const storyProvider: ProviderInfo = { bundleId: 'story', version: '0.0.0' };

/** The id `commands/v1.execute` was given: a contract id, or a ref's `id`. */
const commandId = (command: unknown): string =>
  typeof command === 'string'
    ? command
    : String((command as { readonly id?: unknown } | undefined)?.id);

/**
 * An in-memory `hooks/v1` consumer API: `define` answers a handle whose
 * `execute` validates the input and calls every registered handler in
 * registration order (a failing observer is skipped, as the platform skips
 * it); `use` answers the registrar; `whenAvailable` calls back once the
 * contract is defined.
 */
const createHooks = () => {
  const handlers = new Map<string, Handler[]>();
  const defined = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const key = (contract: HooksContractLike, hook: string) =>
    `${contract.id}#${hook}`;
  const registrar = (contract: HooksContractLike) =>
    Object.fromEntries(
      Object.keys(contract.hooks).map((hook) => [
        hook,
        (handler: Handler): Disposable => {
          const list = handlers.get(key(contract, hook)) ?? [];
          handlers.set(key(contract, hook), [...list, handler]);
          return {
            dispose: () =>
              handlers.set(
                key(contract, hook),
                (handlers.get(key(contract, hook)) ?? []).filter(
                  (other) => other !== handler,
                ),
              ),
          };
        },
      ]),
    );
  return {
    define: (contract: HooksContractLike) => {
      defined.add(contract.id);
      for (const waiter of [...(waiters.get(contract.id) ?? [])]) waiter();
      return Object.fromEntries(
        Object.entries(contract.hooks).map(([hook, definition]) => [
          hook,
          {
            execute: async (input: unknown) => {
              const value = definition.input.parse(input);
              for (const handler of [
                ...(handlers.get(key(contract, hook)) ?? []),
              ]) {
                try {
                  await handler(value);
                } catch {
                  // An observer's failure is the platform's report, not the caller's.
                }
              }
              return undefined;
            },
          },
        ]),
      );
    },
    use: registrar,
    whenAvailable: (
      contract: HooksContractLike,
      callback: (
        registrar: Record<string, (handler: Handler) => Disposable>,
      ) => undefined | (() => unknown),
    ): Disposable => {
      let cleanup: undefined | (() => unknown);
      let ran = false;
      const run = () => {
        if (ran) return;
        ran = true;
        cleanup = callback(registrar(contract)) ?? undefined;
      };
      const set = waiters.get(contract.id) ?? new Set<() => void>();
      waiters.set(contract.id, set);
      set.add(run);
      if (defined.has(contract.id)) run();
      return {
        dispose: () => {
          set.delete(run);
          if (typeof cleanup === 'function') void cleanup();
          cleanup = undefined;
        },
      };
    },
  };
};

export const createFakeHost = (options: HostOptions = {}): FakeHost => {
  const absent = new Set(options.absent ?? []);
  const commandsExecuted: ExecutedCommand[] = [];
  const tabsReceived: TabsCall[] = [];
  const bottomReceived: BottomCall[] = [];

  const records = createRecordsApi({
    projects: options.projects ?? [],
    threads: options.threads ?? [],
    activity: activityOf(options.projects ?? [], options.threads ?? []),
    connection: options.connection ?? 'connected',
    pending: (options.pending ?? []).map(recordsOperation),
    failing: (options.failing ?? []).map(recordsOperation),
  });
  const recordsListeners = new Set<() => void>();
  const subscribe = records.subscribe.bind(records);
  records.subscribe = (listener, call): Disposable => {
    recordsListeners.add(listener);
    const subscription = subscribe(listener, call);
    return {
      dispose: () => {
        recordsListeners.delete(listener);
        subscription.dispose();
      },
    };
  };
  const notifyRecords = (): void => {
    for (const listener of [...recordsListeners]) listener();
  };

  let path = options.path ?? '/';
  const routeListeners = new Set<(match: RouteMatch | undefined) => void>();
  const registeredRoutes: RouteRegistration[] = [];
  const navigation = {
    register: (route: RouteRegistration) => {
      registeredRoutes.push(route);
      return {
        dispose: () => {
          const index = registeredRoutes.indexOf(route);
          if (index >= 0) registeredRoutes.splice(index, 1);
        },
      };
    },
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

  const added = new Map<string, readonly RegionEntry[]>();
  const seeds = new Map<string, readonly RegionEntry[]>();
  const regions = new Map<string, readonly RegionEntry[]>();
  const regionListeners = new Map<string, Set<() => void>>();
  const regionItems = (region: string): readonly RegionEntry[] => {
    const known = regions.get(region);
    if (known !== undefined) return known;
    const seeded =
      seeds.get(region) ??
      (options.regions?.[region] ?? []).map(
        ({ owner, ...item }): RegionEntry => ({
          ...item,
          owner: owner ?? 'story',
        }),
      );
    seeds.set(region, seeded);
    const items = Object.freeze([...seeded, ...(added.get(region) ?? [])]);
    regions.set(region, items);
    return items;
  };
  const regionChanged = (region: string): void => {
    regions.delete(region);
    for (const listener of [...(regionListeners.get(region) ?? [])]) listener();
  };
  const addRegionItem = (region: string, item: RegionItem): Disposable => {
    const entry: RegionEntry = { ...item, owner: item.owner ?? 'workspace' };
    added.set(region, [...(added.get(region) ?? []), entry]);
    regionChanged(region);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        added.set(
          region,
          (added.get(region) ?? []).filter((other) => other !== entry),
        );
        regionChanged(region);
      },
    };
  };
  const subscribeRegion = (region: string, listener: () => void) => {
    const listeners = regionListeners.get(region) ?? new Set<() => void>();
    regionListeners.set(region, listeners);
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };

  // `layout.tabs/v2`: records every call; holds the opened tabs by owner so
  // `current()` answers the last opened tab of the owner `setOwner` named.
  let owner: string | undefined;
  const opened = new Map<
    string,
    { id: string; props?: Readonly<Record<string, unknown>> }[]
  >();
  const tabListeners = new Set<() => void>();
  const tabsChanged = () => {
    for (const listener of [...tabListeners]) listener();
  };
  const tabs = {
    open: (input: {
      readonly id: string;
      readonly props?: Readonly<Record<string, unknown>>;
    }) => {
      tabsReceived.push({ method: 'open', input });
      if (owner === undefined) {
        return Promise.reject(
          Object.assign(new Error('No thread or project is selected.'), {
            code: 'unavailable',
          }),
        );
      }
      const list = (opened.get(owner) ?? []).filter(
        (tab) => tab.id !== input.id,
      );
      opened.set(owner, [
        ...list,
        {
          id: input.id,
          ...(input.props === undefined ? {} : { props: input.props }),
        },
      ]);
      tabsChanged();
      return Promise.resolve();
    },
    close: (input: { readonly id: string }) => {
      tabsReceived.push({ method: 'close', input });
      for (const [key, list] of opened) {
        opened.set(
          key,
          list.filter((tab) => tab.id !== input.id),
        );
      }
      tabsChanged();
      return Promise.resolve();
    },
    focus: (input: unknown) => {
      tabsReceived.push({ method: 'focus', input });
      return Promise.resolve();
    },
    retitle: (input: unknown) => {
      tabsReceived.push({ method: 'retitle', input });
      return Promise.resolve();
    },
    current: () =>
      owner === undefined ? undefined : (opened.get(owner) ?? []).at(-1),
    subscribe: (listener: () => void) => {
      tabListeners.add(listener);
      return { dispose: () => tabListeners.delete(listener) };
    },
    setOwner: (input: { readonly owner?: string }) => {
      tabsReceived.push({ method: 'setOwner', input });
      owner = input.owner;
      tabsChanged();
    },
  };

  const defined = new Set<string>();
  const status = options.connection ?? 'connected';
  const apis: Record<string, unknown> = {
    'runtime.records/v1': records,
    'doric.connection/v1': {
      status: () => status,
      subscribe: () => disposable,
    },
    'ui/v1': {
      define: (tag: string, element: CustomElementConstructor) => {
        if (customElements.get(tag) === undefined)
          customElements.define(tag, element);
        defined.add(tag);
        return disposable;
      },
      create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
        if (defined.has(tag)) {
          const element = document.createElement(tag);
          Object.assign(element, { services }, props ?? {});
          return element;
        }
        const threadId = props?.['thread-id'];
        return tag === 'terminal-rows' && typeof threadId === 'string'
          ? terminalRowsElement(
              options.terminalRows?.[threadId] ?? 0,
              rowsDepth(threadId, options.threads ?? []),
            )
          : placeholderElement(tag, props);
      },
      dispose: (element: object) => {
        const target = element as { remove?: () => void; dispose?: () => void };
        target.remove?.();
        target.dispose?.();
      },
    },
    ...(options.catalog === undefined
      ? {}
      : { 'doric.catalog/v1': { get: () => options.catalog } }),
    'navigation/v1': navigation,
    'regions/v1': {
      add: addRegionItem,
      items: regionItems,
      subscribe: subscribeRegion,
    },
    'commands/v1': {
      register: () => disposable,
      execute: (command: unknown, input?: unknown) => {
        commandsExecuted.push({ command: commandId(command), input });
        return Promise.resolve();
      },
    },
    'hooks/v1': createHooks(),
    'layout.tabs/v2': tabs,
    'layout.conversation/v1': {
      setBottomVisible: (itemId: string, visible: boolean) => {
        bottomReceived.push({ itemId, visible });
      },
    },
  };

  /** What the workspace provides, answered in process. */
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

  const answer = (id: string): unknown => {
    if (absent.has(id)) return undefined;
    const own = provided.get(id);
    if (own !== undefined) return stub(own);
    return apis[id];
  };

  const services = {
    provide: (definition: Definition) => {
      if (provided.has(definition.id)) {
        throw Object.assign(
          new Error(`"${definition.id}" is already provided.`),
          { code: 'registration_conflict' },
        );
      }
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

  return {
    services,
    regionItems,
    executed: () => [...commandsExecuted],
    tabCalls: () => [...tabsReceived],
    bottomCalls: () => [...bottomReceived],
    routes: () => [...registeredRoutes],
    records,
    notifyRecords,
  };
};
