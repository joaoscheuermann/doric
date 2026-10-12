// The route matcher of the core's navigation/v1 (stage 9, D9-18). Pure and
// DOM-free: patterns are compiled once, matched against a pathname only, and
// ranked so that a static segment beats a parameter at the first position
// where two matching patterns differ.

import {
  ContractError,
  type RouteEntry,
  type RouteMatch,
  type RouteRegistration,
} from 'bundle/contracts';

export type Segment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string };

export interface CompiledRoute {
  /** The normalized pattern. */
  readonly pattern: string;
  readonly segments: readonly Segment[];
  readonly route: RouteRegistration;
  /** `bundleId` of the bundle that registered the route. */
  readonly owner: string;
  /** The normalized parent pattern, when the route has one. */
  readonly parent?: string;
}

/** Strips one trailing `/`, except for `/` itself. */
export const normalizePath = (pathname: string): string =>
  pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;

/** The segments of a normalized path; `undefined` when one is empty. */
const split = (path: string): readonly string[] | undefined => {
  if (path === '/') {
    return [];
  }

  if (!path.startsWith('/')) {
    return undefined;
  }

  const parts = path.slice(1).split('/');

  return parts.some((part) => part.length === 0) ? undefined : parts;
};

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Compiles a route; a malformed pattern is `invalid_input`. */
export const compile = (
  route: RouteRegistration,
  owner: string,
): CompiledRoute => {
  const pattern = normalizePath(route.path);
  const parts = split(pattern);

  if (parts === undefined) {
    throw new ContractError(
      'invalid_input',
      `The route path "${route.path}" must start with "/" and have no empty segment.`,
      { path: route.path },
    );
  }

  const names = new Set<string>();
  const segments = parts.map((part): Segment => {
    if (!part.startsWith(':')) {
      return { kind: 'static', value: part };
    }

    const name = part.slice(1);

    if (!PARAM_NAME.test(name)) {
      throw new ContractError(
        'invalid_input',
        `The route path "${route.path}" has an invalid parameter "${part}".`,
        { path: route.path },
      );
    }

    if (names.has(name)) {
      throw new ContractError(
        'invalid_input',
        `The route path "${route.path}" repeats the parameter "${name}".`,
        { path: route.path },
      );
    }

    names.add(name);

    return { kind: 'param', name };
  });

  return {
    pattern,
    segments,
    route,
    owner,
    ...(route.parent === undefined
      ? {}
      : { parent: normalizePath(route.parent) }),
  };
};

/**
 * Two routes conflict when they have the same length and the same
 * static/parameter shape with equal static segments: no path could tell
 * them apart.
 */
export const conflicts = (a: CompiledRoute, b: CompiledRoute): boolean =>
  a.segments.length === b.segments.length &&
  a.segments.every((segment, index) => {
    const other = b.segments[index] as Segment;

    if (segment.kind !== other.kind) {
      return false;
    }

    return (
      segment.kind === 'param' ||
      segment.value === (other as typeof segment).value
    );
  });

/** The decoded params of `route` for `parts`, or `undefined`. */
const paramsOf = (
  route: CompiledRoute,
  parts: readonly string[],
): Record<string, string> | undefined => {
  if (route.segments.length !== parts.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (const [index, segment] of route.segments.entries()) {
    const part = parts[index] as string;

    if (segment.kind === 'static') {
      if (segment.value !== part) {
        return undefined;
      }

      continue;
    }

    try {
      params[segment.name] = decodeURIComponent(part);
    } catch {
      // A malformed `%` escape: the route does not match.
      return undefined;
    }
  }

  return params;
};

/** Negative when `a` ranks before `b`: static wins at the first difference. */
const rank = (a: CompiledRoute, b: CompiledRoute): number => {
  for (const [index, segment] of a.segments.entries()) {
    const other = b.segments[index] as Segment;

    if (segment.kind !== other.kind) {
      return segment.kind === 'static' ? -1 : 1;
    }
  }

  return 0;
};

/** The best route for `pathname` (search and hash are not part of it). */
export const match = (
  routes: readonly CompiledRoute[],
  pathname: string,
):
  | { readonly route: CompiledRoute; readonly match: RouteMatch }
  | undefined => {
  const path = normalizePath(pathname);
  const parts = split(path);

  if (parts === undefined) {
    return undefined;
  }

  let best:
    | { route: CompiledRoute; params: Record<string, string> }
    | undefined;

  for (const route of routes) {
    const params = paramsOf(route, parts);

    if (
      params !== undefined &&
      (best === undefined || rank(route, best.route) < 0)
    ) {
      best = { route, params };
    }
  }

  return best === undefined
    ? undefined
    : {
        route: best.route,
        match: { path, pattern: best.route.pattern, params: best.params },
      };
};

const paramNames = (route: CompiledRoute): readonly string[] =>
  route.segments.flatMap((segment) =>
    segment.kind === 'param' ? [segment.name] : [],
  );

/**
 * The root-first chain of a matched route through `parent`. A parent that is
 * not registered ends the chain there; a cycle ends it too. A parent's params
 * are the child's params restricted to the parent's own names.
 */
export const chainOf = (
  routes: readonly CompiledRoute[],
  matched: { readonly route: CompiledRoute; readonly match: RouteMatch },
): readonly RouteEntry[] => {
  const entries: RouteEntry[] = [
    { match: matched.match, route: matched.route.route },
  ];
  const seen = new Set<CompiledRoute>([matched.route]);
  let current = matched.route;

  while (current.parent !== undefined) {
    const parentPattern = current.parent;
    const parent = routes.find((route) => route.pattern === parentPattern);

    if (parent === undefined || seen.has(parent)) {
      break;
    }

    seen.add(parent);

    const params: Record<string, string> = {};

    for (const name of paramNames(parent)) {
      const value = matched.match.params[name];

      if (value !== undefined) {
        params[name] = value;
      }
    }

    entries.unshift({
      match: { path: matched.match.path, pattern: parent.pattern, params },
      route: parent.route,
    });
    current = parent;
  }

  return entries;
};
