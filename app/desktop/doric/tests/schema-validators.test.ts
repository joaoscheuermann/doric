// Main's JSON Schema validators (the trust point of the window bridge) accept
// every member schema a contract generates, including a method without
// arguments: the empty tuple (`noInput`) of `tools/v1.catalog` and
// `host-config/v1.current` (stage 9 integration).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memberSchema } from 'bundle/runtime';
import { z } from 'zod';

import { createSchemaValidators } from '../src/platform/bridge/validation';

test('a method without arguments takes the empty tuple and nothing else', () => {
  const check = createSchemaValidators().compile(
    memberSchema(z.tuple([]), 'input').schema,
  );

  assert.deepEqual(check([]), []);
  assert.notDeepEqual(check(['extra']), []);
});
