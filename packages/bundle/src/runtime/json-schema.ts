import { z } from 'zod';

import {
  disposableSchema,
  type MethodSpec,
} from '../contracts/basic/common.js';
import type {
  Cardinality,
  HookDefinition,
  StorageIndex,
} from '../contracts/define.js';
import type { Environment } from '../contracts/ids.js';
import type { JsonObject, JsonValue } from '../contracts/types.js';
import type { DescriptorKind } from './descriptor.js';

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

/** The key that marks a process-local value in a generated schema. */
export const LOCAL_KEY = 'x-doric-local';

/**
 * How a process-local value crosses the envelope: `callback` (a function
 * invoked through a handle), `disposable` (a registration released through a
 * handle) or `object` (a handle unwrapped only by the process that exported
 * it). A local value without a codec is marked `true` and never crosses.
 */
export const localCodecKinds = ['callback', 'disposable', 'object'] as const;

export type LocalCodecKind = (typeof localCodecKinds)[number];

/** Marker of a member whose local values have no codec. */
export const localMarker: JsonObject = Object.freeze({ [LOCAL_KEY]: true });

const isLocalCodecKind = (value: unknown): value is LocalCodecKind =>
  (localCodecKinds as readonly unknown[]).includes(value);

/**
 * The codec of one local zod schema: the `x-doric-local` metadata the
 * contract author set with `.meta()`, `disposable` for the basic
 * `disposableSchema`, otherwise none.
 */
const localKindOf = (schema: z.ZodType): LocalCodecKind | undefined => {
  const declared = z.globalRegistry.get(schema)?.[LOCAL_KEY];

  if (isLocalCodecKind(declared)) {
    return declared;
  }

  return schema === disposableSchema ? 'disposable' : undefined;
};

const hasUncodedLocal = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasUncodedLocal);
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record[LOCAL_KEY] === true || Object.values(record).some(hasUncodedLocal)
  );
};

type TupleDef = {
  readonly type: 'tuple';
  readonly items: readonly z.ZodType[];
  readonly rest?: z.ZodType | null;
};

const isOptionalIn = (schema: z.ZodType, io: SchemaDirection): boolean => {
  const internals = (
    schema as unknown as {
      _zod: { optin?: string; optout?: string };
    }
  )._zod;

  return (io === 'input' ? internals.optin : internals.optout) === 'optional';
};

const cache = new WeakMap<z.ZodType, Map<SchemaDirection, MemberSchema>>();

/**
 * JSON Schema 2020-12 of one contract member. Each process-local value with a
 * codec is represented in place by `{ "x-doric-local": "<kind>" }`; a member
 * with any local value without a codec is `{ "x-doric-local": true }`. Tuples
 * carry `minItems` (leading required items) and, without a rest, `maxItems`.
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
      const zodSchema = context.zodSchema as unknown as z.ZodType;
      const def = (zodSchema as { _zod?: { def?: { type?: string } } })._zod
        ?.def;
      const type = def?.type;
      const json = context.jsonSchema as Record<string, unknown>;

      if (type !== undefined && localTypes.has(type)) {
        local = true;

        for (const key of Object.keys(json)) {
          delete json[key];
        }

        json[LOCAL_KEY] = localKindOf(zodSchema) ?? true;

        return;
      }

      if (type === 'tuple') {
        const tuple = def as TupleDef;
        let required = 0;

        while (
          required < tuple.items.length &&
          !isOptionalIn(tuple.items[required] as z.ZodType, io)
        ) {
          required += 1;
        }

        json.minItems = required;

        if (tuple.rest === undefined || tuple.rest === null) {
          json.maxItems = tuple.items.length;
        }
      }
    },
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = generated;
  const result: MemberSchema = Object.freeze({
    schema: hasUncodedLocal(rest) ? localMarker : (rest as JsonObject),
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

/** One contract a part provided, defined or registered during dry activation. */
export type RecordedContract = {
  readonly id: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
} & (
  | {
      readonly kind: 'service';
      readonly methods: Readonly<Record<string, MethodSpec>>;
    }
  | {
      readonly kind: 'hooks';
      readonly hooks: Readonly<Record<string, HookDefinition>>;
    }
  | { readonly kind: 'event'; readonly payload: z.ZodType }
  | { readonly kind: 'command'; readonly input: z.ZodType }
  | { readonly kind: 'settings'; readonly value: z.ZodType }
  | {
      readonly kind: 'storage-type';
      readonly value: z.ZodType;
      readonly indexes: readonly StorageIndex[];
    }
);

export interface ContractDocument {
  readonly document: JsonObject;
  /** True when a member uses process-local types. */
  readonly local: boolean;
}

export const JSON_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema';

/** Path of a contract document relative to a bundle's dist. */
export const schemaPath = (contractId: string): string =>
  `schemas/${contractId}.json`;

/**
 * JSON Schema 2020-12 document of one contract: `$defs` holds each member
 * (`<method>.input`/`.output`, `<hook>.input`, `payload`, `value`, `input`).
 * Inputs describe what a caller sends (`io: input`), outputs what it receives.
 */
export const contractDocument = (
  contract: RecordedContract,
): ContractDocument => {
  const defs: Record<string, JsonObject> = {};
  let local = false;
  const member = (
    key: string,
    schema: z.ZodType,
    io: SchemaDirection,
    extra: JsonObject = {},
  ) => {
    const generated = memberSchema(schema, io);

    local ||= generated.local;
    defs[key] = { ...generated.schema, ...extra };
  };

  switch (contract.kind) {
    case 'service':
      for (const name of Object.keys(contract.methods).sort()) {
        const method = contract.methods[name] as MethodSpec;

        member(`${name}.input`, method.input, 'input');
        member(`${name}.output`, method.output, 'output');
      }
      break;
    case 'hooks':
      for (const name of Object.keys(contract.hooks).sort()) {
        const hook = contract.hooks[name] as HookDefinition;

        member(`${name}.input`, hook.input, 'input', {
          'x-doric-hook-kind': hook.kind,
        });
      }
      break;
    case 'event':
      member('payload', contract.payload, 'input');
      break;
    case 'command':
      member('input', contract.input, 'input');
      break;
    case 'settings':
      member('value', contract.value, 'input');
      break;
    case 'storage-type':
      member('value', contract.value, 'input', {
        'x-doric-indexes': contract.indexes.map((index) => ({
          name: index.name,
          fields: [...index.fields],
          ...(index.unique === undefined ? {} : { unique: index.unique }),
        })),
      });
      break;
  }

  const kind: DescriptorKind = contract.kind;

  return {
    document: {
      $schema: JSON_SCHEMA_DIALECT,
      $id: `doric:contract/${contract.id}`,
      'x-doric-kind': kind,
      $defs: defs,
    },
    local,
  };
};
