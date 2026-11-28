// T4.23 (AC4.23), until S85b: the golden file that `doric-storage`'s golden
// test writes (`bundles/foundation/sqlite/storage/src/schema.rs`) against
// today's TypeScript encoding, so the engine keeps today's key order and
// computes today's index keys: `encodeIndexKey(indexValues(toJson(…)))`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createFileRegistry, fromBinary, toJson } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

import {
  decodeIndexKey,
  encodeIndexKey,
  type IndexScalar,
  indexValues,
} from '../src/index.js';

/** The golden file, from `packages/storage/dist-tests/tests/`. */
const goldenUrl = new URL(
  '../../../../bundles/foundation/sqlite/storage/tests/fixtures/index-keys.json',
  import.meta.url,
);

/** The golden file's layout (spec, "The layout", "The golden file"). */
type Golden = {
  tuples: { tuple: IndexScalar[]; bytes: string }[];
  platformKeys: {
    layout: string;
    migration: string;
    identity: string;
    host: string;
  };
  descriptorSet: string;
  indexKeys: {
    name: string;
    messageType: string;
    value: string;
    fields: string[];
    key: string;
  }[];
};

const readGolden = async (): Promise<Golden> => {
  let text: string;

  try {
    text = await readFile(goldenUrl, 'utf8');
  } catch (error) {
    throw new Error(
      `The golden file ${goldenUrl.pathname} cannot be read; doric-storage's golden test writes it with DORIC_WRITE_GOLDEN=1 (${String(error)}).`,
    );
  }

  return JSON.parse(text) as Golden;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const fromHex = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'hex'));

const fromBase64 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'base64'));

void test('every tuple of the golden file encodes to its bytes and decodes back', async () => {
  const { tuples } = await readGolden();

  assert.ok(tuples.length > 0, 'the golden file lists tuples');

  for (const { tuple, bytes } of tuples) {
    assert.equal(hex(encodeIndexKey(tuple)), bytes, JSON.stringify(tuple));
    assert.deepEqual(decodeIndexKey(fromHex(bytes)), tuple, bytes);
  }
});

void test('each platform key is doric/ followed by the tuple ("meta", name)', async () => {
  const { platformKeys } = await readGolden();
  const prefix = hex(new TextEncoder().encode('doric/'));

  for (const name of ['layout', 'migration', 'identity', 'host'] as const) {
    assert.equal(
      platformKeys[name],
      prefix + hex(encodeIndexKey(['meta', name])),
      name,
    );
  }
});

void test('every index key of the golden file is encodeIndexKey(indexValues(toJson(…))) of its value', async () => {
  const { descriptorSet, indexKeys } = await readGolden();
  const registry = createFileRegistry(
    fromBinary(FileDescriptorSetSchema, fromBase64(descriptorSet)),
  );

  assert.ok(indexKeys.length > 0, 'the golden file lists index keys');

  for (const { name, messageType, value, fields, key } of indexKeys) {
    const schema = registry.getMessage(messageType);

    assert.ok(schema, `${name}: ${messageType} is in the descriptor set`);

    const json = toJson(schema, fromBinary(schema, fromBase64(value)), {
      alwaysEmitImplicit: true,
      registry,
    });

    assert.equal(hex(encodeIndexKey(indexValues(json, fields))), key, name);
  }
});
