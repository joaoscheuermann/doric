import { z } from 'zod';

import type { MethodSpec, MethodSpecs } from '../../contracts/basic/common.js';
import type { JsonObject } from '../../contracts/types.js';

/** One JSON Schema validation failure, relative to the validated value. */
export interface SchemaIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Validates one value; an empty list means valid. */
export type SchemaCheck = (value: unknown) => readonly SchemaIssue[];

/**
 * JSON Schema 2020-12 validation, injected so this runtime stays
 * browser-safe (the host implementation compiles schemas with ajv).
 */
export interface SchemaValidators {
  compile(schema: JsonObject): SchemaCheck;
}

/**
 * A zod schema that accepts what the JSON Schema accepts and reports its
 * issues with their paths, so dispatcher messages keep their format.
 */
export const validatorSchema = (
  validators: SchemaValidators,
  schema: JsonObject,
): z.ZodType => {
  const check = validators.compile(schema);

  return z.any().superRefine((value, context) => {
    for (const issue of check(value)) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: [...issue.path],
      });
    }
  });
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The method spec of one member: a JSON Schema tuple becomes a zod tuple of
 * per-item validators with its optional tail marked optional, so dispatch's
 * argument normalization (trailing call options) works as in-process.
 */
export const memberSpec = (
  validators: SchemaValidators,
  schema: JsonObject,
): z.ZodType => {
  const prefix = schema.prefixItems;

  if (schema.type !== 'array' || !Array.isArray(prefix)) {
    return validatorSchema(validators, schema);
  }

  const items = prefix.filter(isObject);
  const minimum =
    typeof schema.minItems === 'number' ? schema.minItems : items.length;
  const tupleItems = items.map((item, index) => {
    const zod = validatorSchema(validators, item);

    return index < minimum ? zod : zod.optional();
  });
  const rest = schema.items;
  const tuple = z.tuple(tupleItems as [z.ZodType, ...z.ZodType[]]);

  return isObject(rest) ? tuple.rest(validatorSchema(validators, rest)) : tuple;
};

/** Method specs of a bundle-defined contract from its published document. */
export const documentMethodSpecs = (
  validators: SchemaValidators,
  document: JsonObject,
): MethodSpecs => {
  const defs = isObject(document.$defs) ? document.$defs : {};
  const methods: Record<string, MethodSpec> = {};

  for (const key of Object.keys(defs)) {
    const match = /^(.*)\.input$/.exec(key);

    if (match === null) {
      continue;
    }

    const name = match[1] as string;
    const input = defs[key];
    const output = defs[`${name}.output`];

    if (!isObject(input) || !isObject(output)) {
      continue;
    }

    methods[name] = Object.freeze({
      input: memberSpec(validators, input),
      output: memberSpec(validators, output),
    });
  }

  return Object.freeze(methods);
};
