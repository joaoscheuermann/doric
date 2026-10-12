import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { basicContracts } from '../contracts/basic/index.js';
import type { HooksContract } from '../contracts/define.js';
import {
  AppHooksV1,
  platformContracts,
  WindowHooksV1,
} from '../contracts/platform.js';
import type { JsonObject } from '../contracts/types.js';
import { compositionSchema } from '../runtime/composition.js';
import { descriptorSchema } from '../runtime/descriptor.js';
import { manifestV1Schema } from '../runtime/manifest.js';
import { contractDocument, JSON_SCHEMA_DIALECT } from './schemas.js';

const documentOf = (schema: z.ZodType, id: string): JsonObject => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;

  return { $schema: JSON_SCHEMA_DIALECT, $id: id, ...rest } as JsonObject;
};

/** Every platform document, keyed by its path below `schemas/`. */
export const platformSchemaDocuments = (): ReadonlyMap<string, JsonObject> => {
  const documents = new Map<string, JsonObject>([
    [
      'bundle-manifest/v1.json',
      documentOf(
        manifestV1Schema,
        'doric://app/schemas/bundle-manifest/v1.json',
      ),
    ],
    [
      'composition/v1.json',
      documentOf(compositionSchema, 'doric://app/schemas/composition/v1.json'),
    ],
    [
      'contracts-descriptor/v1.json',
      documentOf(
        descriptorSchema,
        'doric://app/schemas/contracts-descriptor/v1.json',
      ),
    ],
  ]);
  const services = {
    ...Object.fromEntries(
      Object.entries(basicContracts).map(([id, spec]) => [
        id,
        { cardinality: spec.cardinality, methods: spec.methods },
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(platformContracts).map(([id, spec]) => [
        id,
        { cardinality: 'one' as const, methods: spec.methods },
      ]),
    ),
  };

  for (const [id, spec] of Object.entries(services)) {
    documents.set(
      `contracts/${id}.json`,
      contractDocument({
        id,
        environment: 'host',
        cardinality: spec.cardinality,
        kind: 'service',
        methods: spec.methods,
      }).document,
    );
  }

  for (const hooks of [AppHooksV1, WindowHooksV1] as readonly HooksContract[]) {
    documents.set(
      `contracts/${hooks.id}.json`,
      contractDocument({
        id: hooks.id,
        environment: 'host',
        cardinality: 'one',
        kind: 'hooks',
        hooks: hooks.hooks,
      }).document,
    );
  }

  return documents;
};

/** Writes the platform documents below `<outDir>/`. */
export const writePlatformSchemas = async (outDir: string): Promise<void> => {
  for (const [path, document] of platformSchemaDocuments()) {
    const target = join(outDir, ...path.split('/'));

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  }
};

const here = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && resolve(process.argv[1]) === here) {
  // dist/build/platform-schemas.js → dist/schemas
  await writePlatformSchemas(join(dirname(here), '..', 'schemas'));
}
