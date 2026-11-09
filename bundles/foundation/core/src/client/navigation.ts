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

/** Options of {@link createNavigation}. */
export interface NavigationOptions {
  /**
   * Whether the provider has `forward` and `history` (navigation/v1@1.1.0).
   * Defaults to whether the app's `navigationMethods` lists both, so a core
   * on an older app provides exactly that app's method list (S35).
   */
  readonly historyMethods?: boolean;
}

/** Whether the app's `navigationMethods` lists both 1.1.0 methods. */
const appListsHistoryMethods =
  Object.hasOwn(navigationMethods, 'forward') &&
  Object.hasOwn(navigationMethods, 'history');

/** The S11 state of one history entry: its place and the list length. */
interface Place {
  readonly index: number;
  readonly max: number;
}

const placeOf = (state: unknown): Place | undefined => {
  if (typeof state !== 'object' || state === null || !('doric' in state)) {
    return undefined;
  }

  const { doric } = state as { doric: unknown };

  if (typeof doric !== 'object' || doric === null) {
    return undefined;
  }

  const { index, max } = doric as { index?: unknown; max?: unknown };

  return Number.isInteger(index) && Number.isInteger(max)
    ? { index: index as number, max: max as number }
    : undefined;
};

/** The entry state the core writes, and nothing else (S11). */
const stateOf = ({ index, max }: Place) => ({ doric: { index, max } });

export const createNavigation = ({
  historyMethods = appListsHistoryMethods,
}: NavigationOptions = {}) => {
  const routes: CompiledRoute[] = [];
  const listeners = new Set<Listener>();
  let chain: readonly RouteEntry[] = Object.freeze([]);
  let listening = false;
  // S11: the current entry's place in the window's session history.
  let index = 0;
  let max = 0;

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

    const start = placeOf(window.history.state);

    if (start === undefined) {
      window.history.replaceState(stateOf({ index, max }), '');
    } else {
      ({ index, max } = start);
    }

    window.addEventListener('popstate', () => {
      const landed = placeOf(window.history.state);

      if (landed === undefined) {
        index = 0;
      } else {
        index = landed.index;
        max = Math.max(max, landed.max, index);
        window.history.replaceState(stateOf({ index, max }), '');
      }

      resolve();
      notify();
    });
  };

  // navigation/v1@1.1.0: only when the app lists them, so a core on an older
  // app provides exactly that app's method list (S35).
  const historyDefinitions = {
    forward: defineMethod({
      input: navigationMethods.forward.input,
      output: navigationMethods.forward.output,
      execute: () => {
        listen();
        window.history.forward();
      },
    }),
    history: defineMethod({
      input: navigationMethods.history.input,
      output: navigationMethods.history.output,
      execute: () => {
        listen();

        return { canGoBack: index > 0, canGoForward: index < max };
      },
    }),
  };

  const methods = {
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
          window.history.replaceState(stateOf({ index, max }), '', url);
        } else {
          index += 1;
          max = index;
          window.history.pushState(stateOf({ index, max }), '', url);
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
  };

  return historyMethods
    ? defineService(NavigationV1, { ...methods, ...historyDefinitions })
    : defineService(NavigationV1.id, methods);
};
