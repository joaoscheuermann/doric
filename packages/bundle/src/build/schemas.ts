import type { z } from 'zod';

import type { MethodSpec } from '../contracts/basic/common.js';
import type {
  Cardinality,
  HookDefinition,
  StorageIndex,
} from '../contracts/define.js';
import type { Environment } from '../contracts/ids.js';
import type { JsonObject } from '../contracts/types.js';
import type { DescriptorKind } from '../runtime/descriptor.js';
import { memberSchema, type SchemaDirection } from '../runtime/json-schema.js';

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
