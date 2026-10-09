import { z } from 'zod';

import type { JsonObject, JsonValue } from '../contracts/types.js';

export type SchemaDirection = 'input' | 'output';

/** Zod types that cannot cross a process boundary as JSON. */
const localTypes = new Set([
  'custom',
  'function',
  'symbol',
  'bigint',
  'date',
  'map',
  'set',
  'promise',
  'nan',
]);

export interface MemberSchema {
  readonly schema: JsonObject;
  /** True when the schema uses a process-local type (functions, z.custom). */
  readonly local: boolean;
}

export const localMarker: JsonObject = Object.freeze({ 'x-doric-local': true });

const cache = new WeakMap<z.ZodType, Map<SchemaDirection, MemberSchema>>();

/**
 * JSON Schema 2020-12 of one contract member. A member that uses a
 * process-local type is represented by `{ "x-doric-local": true }`.
 */
export const memberSchema = (
  schema: z.ZodType,
  io: SchemaDirection,
): MemberSchema => {
  const cached = cache.get(schema)?.get(io);

  if (cached !== undefined) {
    return cached;
  }

  let local = false;
  const generated = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    override: (context) => {
      const type = (context.zodSchema as { _zod?: { def?: { type?: string } } })
        ._zod?.def?.type;

      if (type !== undefined && localTypes.has(type)) {
        local = true;
      }
    },
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = generated;
  const result: MemberSchema = Object.freeze({
    schema: local ? localMarker : (rest as JsonObject),
    local,
  });
  const byDirection = cache.get(schema) ?? new Map();

  byDirection.set(io, result);
  cache.set(schema, byDirection);

  return result;
};

/** JSON with object keys sorted, so equal documents compare equal as text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value));

const sortKeys = (value: unknown): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }

  return value as JsonValue;
};

export const jsonEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);
