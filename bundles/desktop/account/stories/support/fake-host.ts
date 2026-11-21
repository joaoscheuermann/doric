// A fake host for the account's stories and tests (spec section 9, D31): the
// services `activate` binds the account to, answered in memory. It holds the
// layout's service registry (`bundles/desktop/layout/stories/support/fake-host.ts`)
// and the four contracts the account reads: `ui/v1`, `regions/v1`,
// `commands/v1` and `doric.about/v1`. `commands/v1` records each command with
// its input (decision O6).

import type {
  DoricAbout,
  ProviderInfo,
  RegionEntry,
  Services,
} from 'bundle/contracts';

import { placeholderElement } from './placeholder.js';

export type { RegionEntry, Services };

/** A region item a fixture seeds; `owner` defaults to `story`. */
export type RegionItem = Omit<RegionEntry, 'owner'> & {
  readonly owner?: string;
};

export interface HostOptions {
  /** The items other bundles added to each region (`account.status`, `account.menu`). */
  readonly regions?: Readonly<Record<string, readonly RegionItem[]>>;
  /**
   * Contract ids the host does not provide, as an older app lacks a platform
   * contract. For an id listed here `services.use` throws and
   * `services.whenAvailable` never calls back.
   */
  readonly absent?: readonly string[];
}

/** One command executed through `commands/v1`. */
export interface ExecutedCommand {
  /** The contract id, or a ref's `id`. */
  readonly command: string;
  readonly input: unknown;
}

export interface FakeHost {
  /**
   * The services `activate` binds the account to.
   *
   * `use(ref)` answers `doric.about/v1` (`get()` resolves
   * `{ version: '0.0.1' }`), `ui/v1`, `regions/v1` and `commands/v1`, and
   * throws for an id in `absent` or unknown. `ui/v1` creates each element
   * defined through it under its own tag, with these services and the props
   * set on it; any other tag is a placeholder (`placeholder.tsx`).
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
  /**
   * The commands executed through `commands/v1` so far, in order, each with
   * the input it was given. Each call returns a new array.
   */
  executed(): readonly ExecutedCommand[];
}

const disposable = { dispose: () => undefined };

/** The provider a story host's `whenAvailable` callback is bound to. */
const storyProvider: ProviderInfo = { bundleId: 'story', version: '0.0.0' };

/** The id `commands/v1.execute` was given: a contract id, or a ref's `id`. */
const commandId = (command: unknown): string =>
  typeof command === 'string'
    ? command
    : String((command as { readonly id?: unknown } | undefined)?.id);

export const createFakeHost = (options: HostOptions = {}): FakeHost => {
  const absent = new Set(options.absent ?? []);
  const commandsExecuted: ExecutedCommand[] = [];

  // The fixture's items in their order, then the items added through
  // `regions/v1`, in add order.
  const added = new Map<string, readonly RegionEntry[]>();
  const regions = new Map<string, readonly RegionEntry[]>();
  const regionListeners = new Map<string, Set<() => void>>();
  const seeded = (region: string): readonly RegionEntry[] =>
    (options.regions?.[region] ?? []).map(
      ({ owner, ...item }): RegionEntry => ({
        ...item,
        owner: owner ?? 'story',
      }),
    );
  const seeds = new Map<string, readonly RegionEntry[]>();
  const regionItems = (region: string): readonly RegionEntry[] => {
    const known = regions.get(region);
    if (known !== undefined) return known;
    const fixture = seeds.get(region) ?? seeded(region);
    seeds.set(region, fixture);
    const items = Object.freeze([...fixture, ...(added.get(region) ?? [])]);
    regions.set(region, items);
    return items;
  };
  const regionChanged = (region: string): void => {
    regions.delete(region);
    for (const listener of [...(regionListeners.get(region) ?? [])]) listener();
  };
  const addRegionItem = (region: string, item: RegionItem) => {
    const entry: RegionEntry = { ...item, owner: item.owner ?? 'account' };
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

  // The elements defined through `ui/v1`: `create` makes them as the host
  // does, with the services and the props set on the element.
  const defined = new Set<string>();

  const apis: Record<string, unknown> = {
    'doric.about/v1': {
      get: () => Promise.resolve({ version: '0.0.1' }),
    } satisfies DoricAbout,
    'ui/v1': {
      define: (tag: string, element: CustomElementConstructor) => {
        if (customElements.get(tag) === undefined)
          customElements.define(tag, element);
        defined.add(tag);
        return {
          dispose: () => {
            defined.delete(tag);
          },
        };
      },
      create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
        if (defined.has(tag)) {
          const element = document.createElement(tag);
          Object.assign(element, { services }, props ?? {});
          return element;
        }
        return placeholderElement(tag, props);
      },
      // As the host's: the element leaves the document, and one defined
      // through `ui/v1` unmounts its root at once.
      dispose: (element: object) => {
        const target = element as { remove?: () => void; dispose?: () => void };
        target.remove?.();
        target.dispose?.();
      },
    },
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
  };

  /** What `use` answers for `id`, or `undefined` where it throws. */
  const answer = (id: string): unknown =>
    absent.has(id) ? undefined : apis[id];

  const services = {
    provide: () => disposable,
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

  const executed = (): readonly ExecutedCommand[] =>
    commandsExecuted.map((entry) => ({ ...entry }));

  return { services, regionItems, executed };
};
