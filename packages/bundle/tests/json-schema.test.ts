import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  type AnyServiceDefinition,
  disposableSchema,
  functionSchema,
} from '../src/contracts/index.js';
import { buildBundle } from '../src/index.js';
import { contractDocument, memberSchema } from '../src/runtime/index.js';
import {
  contractsUrl,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';

const zodUrl = import.meta.resolve('zod');

// Tuples -----------------------------------------------------------------------

void test('tuples state how many leading items are required and how many items fit', () => {
  const schema = memberSchema(
    z.tuple([z.number(), z.string().optional()]),
    'input',
  ).schema;

  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 2);
  assert.equal(memberSchema(z.tuple([]), 'input').schema.maxItems, 0);
});

void test('a tuple with a rest has no maximum', () => {
  const schema = memberSchema(
    z.tuple([z.number()]).rest(z.string()),
    'input',
  ).schema;

  assert.equal(schema.minItems, 1);
  assert.equal('maxItems' in schema, false);
});

void test('an item with a default is optional for the sender and present for the receiver', () => {
  const tuple = z.tuple([z.number(), z.string().default('x')]);

  assert.equal(memberSchema(tuple, 'input').schema.minItems, 1);
  assert.equal(memberSchema(tuple, 'output').schema.minItems, 2);
});

void test('an optional item before a required one leaves only the leading items required', () => {
  const schema = memberSchema(
    z.tuple([z.number().optional(), z.string()]),
    'input',
  ).schema;

  assert.equal(schema.minItems, 0);
  assert.equal(schema.maxItems, 2);
});

// Local markers ------------------------------------------------------------------

void test('a disposable result is marked with its codec', () => {
  assert.deepEqual(memberSchema(disposableSchema, 'output'), {
    schema: { 'x-doric-local': 'disposable' },
    local: true,
  });
});

void test('declared callbacks and objects are marked in place, the rest stays JSON Schema', () => {
  const member = memberSchema(
    z.tuple([
      z.object({ path: z.string() }),
      functionSchema<() => void>().meta({ 'x-doric-local': 'callback' }),
      z.custom<object>().meta({ 'x-doric-local': 'object' }).optional(),
    ]),
    'input',
  );

  assert.equal(member.local, true);
  assert.deepEqual(member.schema.prefixItems, [
    {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    { 'x-doric-local': 'callback' },
    { 'x-doric-local': 'object' },
  ]);
});

void test('a member with any local value without a codec is refused as a whole', () => {
  for (const schema of [
    z.tuple([z.string(), functionSchema<() => void>()]),
    z.tuple([
      functionSchema<() => void>().meta({ 'x-doric-local': 'callback' }),
      z.custom(() => true),
    ]),
    z.custom(() => true).meta({ 'x-doric-local': 'stream' }),
  ]) {
    assert.deepEqual(memberSchema(schema, 'input'), {
      schema: { 'x-doric-local': true },
      local: true,
    });
  }
});

void test('a member without local values is not local', () => {
  assert.deepEqual(memberSchema(z.array(z.string()), 'output'), {
    schema: { type: 'array', items: { type: 'string' } },
    local: false,
  });
});

// Runtime documents match the build ---------------------------------------------

const hostPart = `import { z } from ${JSON.stringify(zodUrl)};
import { defineMethod, defineService } from ${JSON.stringify(contractsUrl)};
export const api = defineService('drift.api/v1', {
  list: defineMethod({
    input: z.tuple([z.number(), z.string().optional()]),
    output: z.array(z.object({ id: z.string(), at: z.number().optional() })),
    execute: () => [],
  }),
  watch: defineMethod({
    input: z.tuple([z.custom((value) => typeof value === 'function').meta({ 'x-doric-local': 'callback' })]),
    output: z.object({ ok: z.boolean() }),
    execute: () => ({ ok: true }),
  }),
});
export const activate = ({ services }) => {
  services.provide(api);
};
`;

void test('the document computed from a live definition equals the one the build wrote', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'drift', {
      manifest: manifest('drift', { provides: ['drift.api/v1@1.0.0'] }),
      files: { 'dist/host/index.js': hostPart },
    });

    await buildBundle(dir);

    const built = JSON.parse(
      await readFile(
        join(dir, 'dist', 'schemas', 'drift.api', 'v1.json'),
        'utf8',
      ),
    ) as unknown;
    const { api } = (await import(
      pathToFileURL(join(dir, 'dist', 'host', 'index.js')).href
    )) as { api: AnyServiceDefinition };
    const live = contractDocument({
      id: api.id,
      environment: 'host',
      cardinality: api.cardinality,
      kind: 'service',
      methods: api.methods,
    });

    assert.deepEqual(live.document, built);
    assert.equal(live.local, true);
  });
});

void test('a disposable from another copy of the contracts keeps its codec', async () => {
  // A window loads `bundle/contracts` twice: the shell's bundled copy and the
  // import map's, which client parts use. A query string loads a second
  // instance of the same module, as the window does.
  const path = join(import.meta.dirname, '../src/contracts/basic/common.js');
  const copy = (await import(
    `${pathToFileURL(path).href}?copy`
  )) as typeof import('../src/contracts/basic/common.js');
  const own = await import('../src/contracts/basic/common.js');

  assert.notEqual(copy.disposableSchema, own.disposableSchema);
  assert.deepEqual(memberSchema(copy.disposableSchema, 'output').schema, {
    'x-doric-local': 'disposable',
  });
  assert.deepEqual(
    memberSchema(copy.disposableSchema, 'output').schema,
    memberSchema(own.disposableSchema, 'output').schema,
  );
});
