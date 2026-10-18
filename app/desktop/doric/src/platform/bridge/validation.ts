// JSON Schema 2020-12 validation in main (the trust point): ajv compiled
// once per canonical schema, as the host processes do (D4-10).

import { Ajv2020 } from 'ajv/dist/2020';
import type { JsonObject } from 'bundle/contracts';
import {
  canonicalJson,
  compilableSchema,
  type SchemaCheck,
  type SchemaValidators,
} from 'bundle/runtime';

const pathOf = (instancePath: string): (string | number)[] =>
  instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));

export const createSchemaValidators = (): SchemaValidators => {
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: false,
  });
  const cache = new Map<string, SchemaCheck>();

  return {
    compile: (schema: JsonObject): SchemaCheck => {
      const key = canonicalJson(schema);
      const known = cache.get(key);

      if (known !== undefined) {
        return known;
      }

      const validate = ajv.compile(compilableSchema(schema) as JsonObject);
      const check: SchemaCheck = (value) =>
        validate(value)
          ? []
          : (validate.errors ?? []).map((error) => ({
              path: pathOf(error.instancePath),
              message: error.message ?? 'is invalid',
            }));

      cache.set(key, check);

      return check;
    },
  };
};

/** `<path>: <message>` lines, as the dispatcher reports invalid input. */
export const describeSchemaIssues = (
  issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[],
): string =>
  issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
