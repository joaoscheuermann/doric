import { defineStorageType } from 'bundle/contracts';
import { z } from 'zod';

/**
 * One `settings/v1` space, stored as a `core.settings/v1` document whose ID is
 * the settings ID. The document revision is the space's revision.
 */
export const settingsType = defineStorageType({
  type: 'core.settings/v1',
  schema: z
    .object({
      value: z.unknown(),
      /** The owner's contract version from `provides` at the write. */
      version: z.string(),
      /** ISO-8601, milliseconds, UTC. */
      updatedAt: z.string(),
      /** The global settings generation counter after the write. */
      generation: z.number().int(),
    })
    .strict(),
  indexes: [],
});

/** The global settings generation counter (document ID `global`). */
export const settingsGenerationType = defineStorageType({
  type: 'core.settings-generation/v1',
  schema: z.object({ generation: z.number().int().nonnegative() }).strict(),
  indexes: [],
});

/** The document ID of the one settings generation counter. */
export const settingsGenerationId = 'global';
