// The client part of the "core mínimo de teste" (stage 9, §3.2): a core that
// is not the default one opens a window with its own outlet. It provides
// hooks/v1, ui/v1, navigation/v1 and regions/v1 written only against
// bundle/contracts and doric.* contracts, and defines `<id>-outlet`, which
// renders `<p>Minimal core</p>`. Its navigation matches static paths and
// `:param` segments only; it is a test fixture, not the default core.

import {
  NavigationV1,
  navigationMethods,
  type RouteEntry,
  type RouteMatch,
  type RouteRegistration,
} from '../contracts/basic/navigation.js';
import {
  type RegionEntry,
  type RegionItem,
  RegionsV1,
  regionsMethods,
} from '../contracts/basic/regions.js';
import {
  type ElementConstructor,
  UiV1,
  uiMethods,
} from '../contracts/basic/ui.js';
import type { Call } from '../contracts/call.js';
import type {
  Activate,
  ClientContext,
  Disposable,
} from '../contracts/context.js';
import { defineMethod, defineService } from '../contracts/define.js';
import { ContractError } from '../contracts/error.js';
import { DoricElementsV1 } from '../contracts/platform.js';
import type { Descriptor } from '../runtime/descriptor.js';
import type { ManifestV1Input } from '../runtime/manifest.js';
import { createMinimalHooks, disposable } from './minimal-hooks.js';

/** The DOM pieces the minimal core touches (no DOM lib in this package). */
interface DomElement {
  textContent: string | null;
  readonly firstChild: unknown;
  append(...nodes: unknown[]): void;
}

interface Dom {
  readonly HTMLElement: new () => DomElement;
  readonly document: { createElement(tag: string): DomElement };
  readonly location?: { readonly pathname: string };
  readonly history?: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
    back(): void;
  };
}

const dom = (): Dom => globalThis as unknown as Dom;

export interface MinimalUiCore {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  readonly client: { readonly activate: Activate<ClientContext> };
}

const contracts = ['hooks/v1', 'ui/v1', 'navigation/v1', 'regions/v1'] as const;

/** Text the minimal core's outlet renders. */
export const MINIMAL_CORE_TEXT = 'Minimal core';

const segments = (path: string): readonly string[] =>
  path.split('/').filter((segment) => segment.length > 0);

const matchRoute = (
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  const want = segments(pattern);
  const have = segments(path);

  if (want.length !== have.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (const [index, segment] of want.entries()) {
    const actual = have[index] as string;

    if (segment.startsWith(':')) {
      params[segment.slice(1)] = actual;
    } else if (segment !== actual) {
      return undefined;
    }
  }

  return params;
};

const createNavigation = () => {
  const routes: RouteRegistration[] = [];
  const listeners = new Set<(match: RouteMatch | undefined) => void>();
  let path = dom().location?.pathname ?? '/';
  let chain: readonly RouteEntry[] = [];

  const resolve = (): void => {
    const route = routes.find(
      (candidate) => matchRoute(candidate.path, path) !== undefined,
    );
    const entries: RouteEntry[] = [];
    let current = route;

    while (current !== undefined) {
      const params = matchRoute(current.path, path) ?? {};

      entries.unshift({
        match: { path, pattern: current.path, params: { ...params } },
        route: current,
      });
      const parent = current.parent;

      current =
        parent === undefined
          ? undefined
          : routes.find((candidate) => candidate.path === parent);
    }

    chain = Object.freeze(entries);
  };
  const notify = () => {
    const match = chain.at(-1)?.match;

    for (const listener of listeners) {
      listener(match);
    }
  };

  return defineService(NavigationV1, {
    register: defineMethod({
      input: navigationMethods.register.input,
      output: navigationMethods.register.output,
      execute: (route: RouteRegistration): Disposable => {
        if (routes.some((candidate) => candidate.path === route.path)) {
          throw new ContractError(
            'route_conflict',
            `A route for "${route.path}" is already registered.`,
          );
        }

        routes.push(route);
        resolve();
        notify();

        return disposable(() => {
          routes.splice(routes.indexOf(route), 1);
          resolve();
          notify();
        });
      },
    }),
    navigate: defineMethod({
      input: navigationMethods.navigate.input,
      output: navigationMethods.navigate.output,
      execute: ([next, options]: [string, { replace?: boolean }?]) => {
        if (next === path) {
          return;
        }

        path = next;

        if (options?.replace === true) {
          dom().history?.replaceState(null, '', next);
        } else {
          dom().history?.pushState(null, '', next);
        }

        resolve();
        notify();
      },
    }),
    back: defineMethod({
      input: navigationMethods.back.input,
      output: navigationMethods.back.output,
      execute: () => dom().history?.back(),
    }),
    current: defineMethod({
      input: navigationMethods.current.input,
      output: navigationMethods.current.output,
      execute: () => chain.at(-1)?.match,
    }),
    chain: defineMethod({
      input: navigationMethods.chain.input,
      output: navigationMethods.chain.output,
      execute: () => chain,
    }),
    subscribe: defineMethod({
      input: navigationMethods.subscribe.input,
      output: navigationMethods.subscribe.output,
      execute: (listener: (match: RouteMatch | undefined) => void) => {
        listeners.add(listener);

        return disposable(() => listeners.delete(listener));
      },
    }),
  });
};

const createRegions = () => {
  const regions = new Map<
    string,
    {
      entries: (RegionEntry & { readonly seq: number })[];
      sorted: readonly RegionEntry[];
    }
  >();
  const listeners = new Map<string, Set<() => void>>();
  let seq = 0;
  const regionOf = (name: string) => {
    let region = regions.get(name);

    if (region === undefined) {
      region = { entries: [], sorted: Object.freeze([]) };
      regions.set(name, region);
    }

    return region;
  };
  const changed = (name: string) => {
    const region = regionOf(name);

    region.sorted = Object.freeze(
      [...region.entries]
        .sort(
          (left, right) =>
            (left.order ?? Number.POSITIVE_INFINITY) -
              (right.order ?? Number.POSITIVE_INFINITY) || left.seq - right.seq,
        )
        .map(({ seq: _seq, ...entry }) => Object.freeze(entry)),
    );

    for (const listener of listeners.get(name) ?? []) {
      listener();
    }
  };

  return defineService(RegionsV1, {
    add: defineMethod({
      input: regionsMethods.add.input,
      output: regionsMethods.add.output,
      execute: ([name, item]: [string, RegionItem], call: Call) => {
        const region = regionOf(name);

        if (region.entries.some((entry) => entry.id === item.id)) {
          throw new ContractError(
            'registration_conflict',
            `Region "${name}" already has an item "${item.id}".`,
          );
        }

        const entry = { ...item, owner: call.caller.bundleId, seq: seq++ };

        region.entries.push(entry);
        changed(name);

        return disposable(() => {
          region.entries.splice(region.entries.indexOf(entry), 1);
          changed(name);
        });
      },
    }),
    items: defineMethod({
      input: regionsMethods.items.input,
      output: regionsMethods.items.output,
      execute: (name: string) => regionOf(name).sorted,
    }),
    subscribe: defineMethod({
      input: regionsMethods.subscribe.input,
      output: regionsMethods.subscribe.output,
      execute: ([name, listener]: [string, () => void]) => {
        const set = listeners.get(name) ?? new Set<() => void>();

        set.add(listener);
        listeners.set(name, set);

        return disposable(() => set.delete(listener));
      },
    }),
  });
};

/** The minimal core's client part; `id` defaults to `mincore`. */
export const minimalUiCore = (
  options: { readonly id?: string } = {},
): MinimalUiCore => {
  const id = options.id ?? 'mincore';

  return {
    manifest: {
      manifestVersion: 1,
      id,
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      provides: contracts.map((contract) => `${contract}@1.0.0`),
      requires: [],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version: '1.0.0' },
      contracts: contracts.map((contract) => ({
        id: contract,
        version: '1.0.0',
        kind: 'service' as const,
        environment: 'client' as const,
        cardinality: 'one' as const,
        local: true,
        schema: `schemas/${contract}.json`,
      })),
    },
    client: {
      activate: ({ services }) => {
        services.provide(createMinimalHooks());

        const elements = services.use(DoricElementsV1);

        services.provide(
          // By ID: the typed form cannot express ui/v1's one-object dispose.
          defineService(UiV1.id, {
            define: defineMethod({
              input: uiMethods.define.input,
              output: uiMethods.define.output,
              execute: (
                [tag, element]: [string, ElementConstructor],
                call: Call,
              ) => {
                if (!tag.startsWith(`${call.caller.bundleId}-`)) {
                  throw new ContractError(
                    'invalid_input',
                    `Bundle "${call.caller.bundleId}" may define only tags starting with "${call.caller.bundleId}-".`,
                  );
                }

                return elements.define({ tag, element, owner: call.caller });
              },
            }),
            create: defineMethod({
              input: uiMethods.create.input,
              output: uiMethods.create.output,
              execute: ([tag, props]: [
                string,
                Readonly<Record<string, unknown>>?,
              ]) => {
                const element = dom().document.createElement(tag);

                Object.assign(element, props ?? {});
                elements.attach(element);

                return element;
              },
            }),
            dispose: defineMethod({
              input: uiMethods.dispose.input,
              output: uiMethods.dispose.output,
              execute: (element: object) => elements.release(element),
            }),
          }),
        );
        services.provide(createNavigation());
        services.provide(createRegions());

        const Base = dom().HTMLElement;

        class MinimalOutlet extends Base {
          connectedCallback(): void {
            if (this.firstChild === null) {
              const paragraph = dom().document.createElement('p');

              paragraph.textContent = MINIMAL_CORE_TEXT;
              this.append(paragraph);
            }
          }
        }

        services.use(UiV1).define(`${id}-outlet`, MinimalOutlet);
      },
    },
  };
};
