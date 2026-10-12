// The host's composition overrides (HR-6, Q4): what the recovery actions
// "Disable a bundle" and "Return to default composition" persist. A JSON file
// next to the active composition, never the product database; the composition
// file itself is not rewritten, so clearing the overrides returns to it.

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { Composition } from '../runtime/composition.js';

export const compositionOverridesSchema = z
  .object({ disabled: z.array(z.string().min(1)) })
  .strict();

export type CompositionOverrides = z.output<typeof compositionOverridesSchema>;

/** `composition.overrides.json` in the directory of the active composition. */
export const compositionOverridesPath = (compositionPath: string): string =>
  join(dirname(compositionPath), 'composition.overrides.json');

/** The persisted overrides, or `undefined` when there are none. */
export const readCompositionOverrides = async (
  path: string,
): Promise<CompositionOverrides | undefined> => {
  let source: string;

  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;

    throw error;
  }

  try {
    return compositionOverridesSchema.parse(JSON.parse(source));
  } catch (cause) {
    throw new Error(`Invalid composition overrides "${path}".`, { cause });
  }
};

/** Replaces the overrides atomically (a temporary file renamed over it). */
export const writeCompositionOverrides = async (
  path: string,
  overrides: CompositionOverrides,
): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(
      temporary,
      `${JSON.stringify(compositionOverridesSchema.parse(overrides), null, 2)}\n`,
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Removes the overrides: the next catalog uses the composition as written. */
export const clearCompositionOverrides = async (
  path: string,
): Promise<void> => {
  await rm(path, { force: true });
};

/** The composition with each disabled bundle left out of `enabled`. */
export const applyCompositionOverrides = (
  composition: Composition,
  overrides: CompositionOverrides | undefined,
): Composition => {
  if (overrides === undefined || overrides.disabled.length === 0) {
    return composition;
  }

  const disabled = new Set(overrides.disabled);

  return {
    ...composition,
    enabled: composition.enabled.filter((id) => !disabled.has(id)),
  };
};
