import { z } from 'zod';

import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
} from './common.js';

export const regionItemSchema = z
  .object({
    id: z.string(),
    tag: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    order: z.number().optional(),
  })
  .strict();

export type RegionItem = z.output<typeof regionItemSchema>;

/** A region item with the bundle that added it. */
export interface RegionEntry extends RegionItem {
  /** `bundleId` of the caller of `add`. */
  readonly owner: string;
}

/** First provider in stage 9 (client). */
export interface Regions {
  /** A duplicate `(region, id)` fails with `registration_conflict`. */
  add(region: string, item: RegionItem): Disposable;
  /**
   * The region's items sorted by `order` ascending (absent order last), then
   * by add order. The same array is returned until the region changes.
   */
  items(region: string): readonly RegionEntry[];
  /** Called after every change of the region. */
  subscribe(region: string, listener: () => void): Disposable;
}

export const RegionsV1 = ref<Regions>('regions/v1');

export const regionsMethods = {
  add: {
    input: z.tuple([z.string(), regionItemSchema]),
    output: disposableSchema,
  },
  items: {
    input: z.string(),
    output: z.custom<readonly RegionEntry[]>((value) => Array.isArray(value), {
      message: 'Expected an array of region entries.',
    }),
  },
  subscribe: {
    input: z.tuple([z.string(), functionSchema<() => void>()]),
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;
