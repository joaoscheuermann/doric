import { ContractError, type StorageTypeDefinition } from 'bundle/contracts';
import { z } from 'zod';

interface Def {
  readonly type?: string;
  readonly [key: string]: unknown;
}

const defOf = (schema: unknown): Def =>
  ((schema as { _zod?: { def?: Def } })._zod?.def ?? {}) as Def;

/** Wrappers whose stored value is the inner schema's value. */
const wrappers = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
  'success',
]);

/** Schemas that may hold any value at any path. */
const open = new Set(['any', 'unknown', 'custom', 'transform']);

const isIndex = (segment: string): boolean => /^(0|[1-9][0-9]*)$/.test(segment);

/**
 * Whether a dotted index field names a place the schema can hold: object
 * keys, record values, array or tuple positions, through optional, nullable,
 * default, lazy, pipe (its output), union and intersection.
 */
const resolves = (schema: unknown, segments: readonly string[]): boolean => {
  const def = defOf(schema);
  const type = def.type ?? 'unknown';

  if (open.has(type)) {
    return true;
  }

  if (wrappers.has(type)) {
    return resolves(def.innerType, segments);
  }

  if (type === 'lazy') {
    return resolves((def.getter as () => unknown)(), segments);
  }

  if (type === 'pipe') {
    return resolves(def.out, segments);
  }

  if (type === 'union') {
    return (def.options as readonly unknown[]).some((option) =>
      resolves(option, segments),
    );
  }

  if (type === 'intersection') {
    return resolves(def.left, segments) || resolves(def.right, segments);
  }

  const [head, ...rest] = segments;

  if (head === undefined) {
    return true;
  }

  if (type === 'object') {
    const shape = def.shape as Readonly<Record<string, unknown>>;

    if (Object.hasOwn(shape, head)) {
      return resolves(shape[head], rest);
    }

    return def.catchall !== undefined && resolves(def.catchall, rest);
  }

  if (type === 'record') {
    return resolves(def.valueType, rest);
  }

  if (type === 'array') {
    return isIndex(head) && resolves(def.element, rest);
  }

  if (type === 'tuple') {
    const items = def.items as readonly unknown[];

    return (
      isIndex(head) &&
      (Number(head) < items.length
        ? resolves(items[Number(head)], rest)
        : def.rest !== undefined &&
          def.rest !== null &&
          resolves(def.rest, rest))
    );
  }

  return false;
};

/** Index names are unique and every field resolves in the type's schema. */
export const assertIndexes = (definition: StorageTypeDefinition): void => {
  const names = new Set<string>();

  for (const index of definition.indexes) {
    if (names.has(index.name)) {
      throw new ContractError(
        'invalid_input',
        `Storage type ${definition.type} declares the index "${index.name}" twice.`,
        { type: definition.type, index: index.name },
      );
    }

    names.add(index.name);

    for (const field of index.fields) {
      if (field === '' || !resolves(definition.schema, field.split('.'))) {
        throw new ContractError(
          'invalid_input',
          `The field "${field}" of index "${index.name}" does not exist in the schema of ${definition.type}.`,
          { type: definition.type, index: index.name, field },
        );
      }
    }
  }
};

let opaque = 0;

/**
 * What makes two definitions of one type the same: the generated JSON Schema
 * of the value and the declared indexes.
 */
export const fingerprintOf = (definition: StorageTypeDefinition): string => {
  let schema: unknown;

  try {
    schema = z.toJSONSchema(definition.schema, {
      io: 'input',
      unrepresentable: 'any',
    });
  } catch {
    // A schema with no JSON Schema form is only the same as itself.
    opaque += 1;
    schema = { opaque };
  }

  return JSON.stringify({
    schema,
    indexes: definition.indexes.map(({ name, fields, unique }) => ({
      name,
      fields,
      unique: unique === true,
    })),
  });
};
