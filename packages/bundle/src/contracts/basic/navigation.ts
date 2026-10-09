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

/** First provider in stage 9 (client, one per window). */
export interface Navigation {
  register(route: RouteRegistration): Disposable;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  back(): void;
  current(): RouteMatch | undefined;
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
  current: { input: noInput, output: routeMatchSchema.optional() },
  subscribe: {
    input: functionSchema<(match: RouteMatch | undefined) => void>(),
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;
