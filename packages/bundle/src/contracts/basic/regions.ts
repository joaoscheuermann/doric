import { z } from 'zod';

import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import { disposableSchema, type MethodSpecs } from './common.js';

export const regionItemSchema = z
  .object({
    id: z.string(),
    tag: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    order: z.number().optional(),
  })
  .strict();

export type RegionItem = z.output<typeof regionItemSchema>;

/** First provider in stage 9 (client). */
export interface Regions {
  add(region: string, item: RegionItem): Disposable;
}

export const RegionsV1 = ref<Regions>('regions/v1');

export const regionsMethods = {
  add: {
    input: z.tuple([z.string(), regionItemSchema]),
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;
