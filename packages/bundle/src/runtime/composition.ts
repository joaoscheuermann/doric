import { z } from 'zod';

import { contractIdPattern } from '../contracts/ids.js';

/** The host's structural composition: one core, enabled bundles, chosen providers. */
export const compositionSchema = z
  .object({
    core: z.string().min(1),
    enabled: z.array(z.string().min(1)).min(1),
    providers: z
      .record(z.string().regex(contractIdPattern), z.string().min(1))
      .default({}),
  })
  .strict();

export type Composition = z.output<typeof compositionSchema>;

export const parseComposition = (document: unknown): Composition =>
  compositionSchema.parse(document);
