// The core's client navigation/v1 (stage 9, §4.4): one per window, over the
// History API. Routes are matched on the pathname only; `current()` and
// `chain()` are cached and replaced only when a resolve changes them.

import {
  type Call,
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
  NavigationV1,
  navigationMethods,
  type RouteEntry,
  type RouteMatch,
  type RouteRegistration,
} from 'bundle/contracts';

import { once } from './disposable.js';
import { sameOrigin } from './origin.js';
import {
  type CompiledRoute,
  chainOf,
  compile,
  conflicts,
  match,
} from './route-match.js';

type Listener = (match: RouteMatch | undefined) => void;

const sameMatch = (
  left: readonly RouteEntry[],
  right: readonly RouteEntry[],
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index] as RouteEntry;
    const keys = Object.keys(entry.match.params);

    return (
      entry.route === other.route &&
      entry.match.path === other.match.path &&
      entry.match.pattern === other.match.pattern &&
      keys.length === Object.keys(other.match.params).length &&
      keys.every((key) => entry.match.params[key] === other.match.params[key])
    );
  });

const freeze = (entries: readonly RouteEntry[]): readonly RouteEntry[] =>
  Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        route: entry.route,
        match: Object.freeze({
          ...entry.match,
          params: Object.freeze({ ...entry.match.params }),
        }),
      }),
    ),
  );

export const createNavigation = () => {
  const routes: CompiledRoute[] = [];
  const listeners = new Set<Listener>();
  let chain: readonly RouteEntry[] = Object.freeze([]);
  let listening = false;

  const resolve = (): boolean => {
    const found = match(routes, window.location.pathname);
    const next = found === undefined ? [] : chainOf(routes, found);

    if (sameMatch(chain, next)) {
      return false;
    }

    chain = freeze(next);

    return true;
  };

  const notify = () => {
    const current = chain.at(-1)?.match;

    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch (error) {
        console.error('Doric: a navigation listener failed:', error);
      }
    }
  };

  const listen = () => {
    if (listening) {
      return;
    }

    listening = true;
    window.addEventListener('popstate', () => {
      resolve();
      notify();
    });
  };

  return defineService(NavigationV1, {
    register: defineMethod({
      input: navigationMethods.register.input,
      output: navigationMethods.register.output,
      execute: (route: RouteRegistration, call: Call): Disposable => {
        listen();

        const compiled = compile(route, call.caller.bundleId);
        const existing = routes.find((other) => conflicts(other, compiled));

        if (existing !== undefined) {
          throw new ContractError(
            'route_conflict',
            `The path "${compiled.pattern}" is already registered by ${existing.owner}.`,
            { path: compiled.pattern, owner: existing.owner },
          );
        }

        routes.push(compiled);

        if (resolve()) {
          notify();
        }

        return once(() => {
          const index = routes.indexOf(compiled);

          if (index >= 0) {
            routes.splice(index, 1);
          }

          if (resolve()) {
            notify();
          }
        });
      },
    }),
    navigate: defineMethod({
      input: navigationMethods.navigate.input,
      output: navigationMethods.navigate.output,
      execute: ([path, options]: [string, { replace?: boolean }?]) => {
        listen();

        const url = new URL(path, window.location.href);

        if (!sameOrigin(url)) {
          throw new ContractError(
            'invalid_input',
            `Cannot navigate to "${path}": it is not in this window's origin.`,
            { path },
          );
        }

        const target = `${url.pathname}${url.search}${url.hash}`;
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const replace = options?.replace === true;

        if (target === here && !replace) {
          return;
        }

        if (replace) {
          window.history.replaceState(null, '', url);
        } else {
          window.history.pushState(null, '', url);
        }

        resolve();
        notify();
      },
    }),
    back: defineMethod({
      input: navigationMethods.back.input,
      output: navigationMethods.back.output,
      execute: () => {
        listen();
        window.history.back();
      },
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
      execute: (listener: Listener) => {
        listen();
        listeners.add(listener);

        return once(() => listeners.delete(listener));
      },
    }),
  });
};
