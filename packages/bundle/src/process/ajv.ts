import { Ajv2020 } from 'ajv/dist/2020.js';

import type { JsonObject } from '../contracts/types.js';
import type {
  SchemaCheck,
  SchemaValidators,
} from '../runtime/envelope/validators.js';
import { canonicalJson } from '../runtime/json-schema.js';

const pathOf = (instancePath: string): (string | number)[] =>
  instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));

/**
 * JSON Schema 2020-12 validation for the host processes (D4-10): ajv with
 * JSON Schema semantics, compiled once per canonical schema.
 */
export const ajvValidators = (): SchemaValidators => {
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

      const validate = ajv.compile(schema);
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
