// A fake host for the layout stories and tests: the services `activate`
// binds the shell to, answered in memory. The services the layout itself
// provides (`layout.tabs/v2` and the rest) are kept and answered in process.
// Since bundle isolation 4(c) the shell reads no Project or Thread: the host
// holds no records mirror, no terminal rows and no `doric.about/v1`, and an
// element another bundle draws (the chat's tab icon among them) is a
// placeholder.

import type {
  CatalogSnapshot,
  Disposable,
  Navigation,
  ProviderInfo,
} from 'bundle/contracts';
import { FileDiffIcon, FileIcon, type LucideIcon } from 'lucide-react';
import { type ComponentProps, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { ProjectPanel } from '../../src/client/components/organisms/project-panel.js';
import type { activate } from '../../src/client/index.js';
import type { StackPane } from '../../src/contracts/index.js';
import { placeholderElement } from './placeholder.js';

export type { StackPane };

export type Services = Parameters<typeof activate>[0]['services'];

/** A `regions/v1` entry, as the panel and the region stand-ins read it. */
export type RegionEntry = ComponentProps<typeof ProjectPanel>['items'][number];

export type RegionItem = Omit<RegionEntry, 'owner'> & {
  readonly owner?: string;
};

export interface HostOptions {
  /** The window path the story opens at. */
  readonly path?: string;
  readonly connection?: 'connected' | 'disconnected';
  /** The items other bundles added to each region. */
  readonly regions?: Readonly<Record<string, readonly RegionItem[]>>;
  /**
   * Contract ids the host does not provide, as an older app lacks a platform
   * contract. For an id listed here:
   * - `services.use` throws, as it does for any id the host does not know;
   * - `services.whenAvailable` never calls back.
   * Wins over the host's own answers and over what the layout provides.
   */
  readonly absent?: readonly string[];
  /**
   * The bundle catalog the window's `doric.catalog/v1` reports: with it,
   * `services.use('doric.catalog/v1').get()` answers this snapshot (the same
   * object on every call). Absent: the host does not provide the contract,
   * so `use` throws for it, as it does for any id the host does not know.
   * `LayoutFixture` extends `HostOptions`, so `bindLayout` and
   * `renderShell` pass it through unchanged.
   */
  readonly catalog?: CatalogSnapshot;
}

/**
 * The `account` bundle's `<account-status>` (step 4(b), decision O1): a
 * button named "Account", where the running app draws the avatar that opens
 * the account menu.
 */
const accountStandIn = (): HTMLElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Account');
  button.dataset.storyPlaceholder = 'account-status';
  return button;
};

/**
 * The icon elements `files` and `git` define (`files-file-icon`,
 * `git-file-diff-icon`), as the running app draws them: a 16 px glyph.
 */
const glyphIcons: Readonly<Record<string, LucideIcon>> = {
  'files-file-icon': FileIcon,
  'git-file-diff-icon': FileDiffIcon,
};

const glyphElement = (icon: LucideIcon): HTMLElement => {
  const element = document.createElement('span');
  element.style.display = 'contents';
  createRoot(element).render(createElement(icon));
  return element;
};

/** The region items the running app adds, by the bundles that add them. */
export const appRegions: Readonly<Record<string, readonly RegionItem[]>> = {
  'shell.panel': [
    {
      id: 'files',
      tag: 'files-tree',
      order: 100,
      owner: 'files',
      props: { label: 'Files', iconTag: 'files-file-icon' },
    },
    {
      id: 'changes',
      tag: 'git-changes',
      order: 200,
      owner: 'git',
      props: {
        label: 'Changes',
        iconTag: 'git-file-diff-icon',
        badgeTag: 'git-changes-badge',
      },
    },
  ],
  'shell.header.actions': [
    {
      id: 'terminal-new',
      tag: 'terminal-new-button',
      order: 10,
      owner: 'terminal',
    },
  ],
  'shell.conversation.footer': [
    { id: 'usage', tag: 'usage-summary', order: 30, owner: 'usage' },
  ],
  'shell.panel.footer': [
    { id: 'git-cwd', tag: 'git-workspace-cwd', order: 10, owner: 'git' },
  ],
  'shell.conversation.bottom': [
    { id: 'terminals', tag: 'terminal-panel', owner: 'terminal' },
  ],
};

/** The Screens group the screen bundle adds below the Threads list. */
export const screenPane: StackPane = {
  id: 'screen-sidebar',
  order: 10,
  title: 'Screens',
  tag: 'screen-sidebar',
  headerTag: 'screen-group-action',
  collapsible: true,
  initiallyOpen: false,
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

export interface FakeHost {
  /**
   * The services `activate` binds the layout to.
   *
   * `use(ref)` answers an id the layout provided, then the host's own
   * answers: `doric.connection/v1`, `doric.catalog/v1` (with `catalog`),
   * `ui/v1`, `navigation/v1`, `regions/v1` and `commands/v1`. It throws for an id in
   * `absent` or unknown. `ui/v1` creates each element defined through it
   * under its own tag, with these services; any other tag is a stand-in.
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
  /**
   * The items of a region: the fixture's, then those added through
   * `regions/v1`, whose `subscribe` hears every change. The same array until
   * the region changes.
   */
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
  const absent = new Set(options.absent ?? []);
  const commandsExecuted: string[] = [];

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

  // The fixture's items in their order, then the items added through
  // `regions/v1`, in add order.
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
    const entry: RegionEntry = { ...item, owner: item.owner ?? 'layout' };
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

  // The elements the layout defined through `ui/v1`: `create` makes them as
  // the host does, with the services and the props set on the element.
  const defined = new Set<string>();

  const status = options.connection ?? 'connected';
  const apis: Record<string, unknown> = {
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
        if (tag === 'account-status') return accountStandIn();
        const glyph = glyphIcons[tag];
        if (glyph !== undefined) return glyphElement(glyph);
        return placeholderElement(tag, props);
      },
      // As the host's: the element leaves the document, and one the layout
      // defined unmounts its root at once.
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
