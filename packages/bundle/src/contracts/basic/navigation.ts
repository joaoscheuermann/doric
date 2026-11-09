import { z } from 'zod';

import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
  noInput,
} from './common.js';

export const routeMatchSchema = z
  .object({
    path: z.string(),
    pattern: z.string(),
    params: z.record(z.string(), z.string()),
  })
  .strict();

export type RouteMatch = z.output<typeof routeMatchSchema>;

export interface RouteRegistration {
  readonly path: string;
  readonly create: (match: RouteMatch) => object;
  readonly parent?: string;
}

/** One route of the active chain: its match (own params only) and its registration. */
export interface RouteEntry {
  readonly match: RouteMatch;
  readonly route: RouteRegistration;
}

/** Whether the window's history can move back or forward from its entry (S11). */
export interface NavigationHistory {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/**
 * First provider in stage 9 (client, one per window). `forward` and `history`
 * came in 1.1.0 and are optional (`basicContracts['navigation/v1'].optional`):
 * a provider written against 1.0.0 omits them, so a caller checks
 * `Object.hasOwn(navigationMethods, 'history')` before it calls them.
 */
export interface Navigation {
  register(route: RouteRegistration): Disposable;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  back(): void;
  /** Steps one entry forward in the window's history; `subscribe` fires after it. */
  forward(): void;
  /** Whether Back and Forward can move, from the core's `{ index, max }` (S11). */
  history(): NavigationHistory;
  current(): RouteMatch | undefined;
  /**
   * Root-first chain of the active route through `parent`; `[]` when no
   * route matches. The same array is returned until the next navigation.
   */
  chain(): readonly RouteEntry[];
  subscribe(listener: (match: RouteMatch | undefined) => void): Disposable;
}

export const NavigationV1 = ref<Navigation>('navigation/v1');

export const navigationMethods = {
  register: {
    input: z
      .object({
        path: z.string(),
        create: functionSchema<(match: RouteMatch) => object>(),
        parent: z.string().optional(),
      })
      .strict(),
    output: disposableSchema,
  },
  navigate: {
    input: z.tuple([
      z.string(),
      z.object({ replace: z.boolean().optional() }).strict().optional(),
    ]),
    output: z.void(),
  },
  back: { input: noInput, output: z.void() },
  forward: { input: noInput, output: z.void() },
  history: {
    input: noInput,
    output: z
      .object({ canGoBack: z.boolean(), canGoForward: z.boolean() })
      .strict(),
  },
  current: { input: noInput, output: routeMatchSchema.optional() },
  chain: {
    input: noInput,
    output: z.custom<readonly RouteEntry[]>((value) => Array.isArray(value), {
      message: 'Expected an array of route entries.',
    }),
  },
  subscribe: {
    input: functionSchema<(match: RouteMatch | undefined) => void>(),
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;
