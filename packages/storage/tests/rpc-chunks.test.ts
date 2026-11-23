// The chunked JSON codec of `storage/rpc` (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4";
// section 3, "Size", rule 3): values cross as JSON text in UTF-8, in chunks
// of at most 1 MiB.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isContractError } from 'bundle/contracts';

import {
  type ChunkFailure,
  chunkBytes,
  decodeJson,
  encodeJson,
  joinChunks,
  maxChunkBytes,
} from '../src/rpc/index.js';

const MiB = 1_048_576;
const utf8 = new TextEncoder();
const failures: readonly ChunkFailure[] = ['invalid_input', 'invalid_output'];

const isCode = (code: string) => (error: unknown) => {
  assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
  assert.equal(error.code, code, error.message);

  return true;
};

const patterned = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 13 + 5) % 256;
  }

  return bytes;
};

void test('a chunk holds at most 1 MiB', () => {
  assert.equal(maxChunkBytes, MiB);
});

for (const [length, count] of [
  [0, 0],
  [1, 1],
  [MiB, 1],
  [MiB + 1, 2],
] as const) {
  void test(`chunkBytes of ${length} bytes gives ${count} non-empty chunks that join to the input`, () => {
    const bytes = patterned(length);
    const chunks = chunkBytes(bytes);

    assert.equal(chunks.length, count);

    for (const chunk of chunks) {
      assert.ok(chunk.length > 0 && chunk.length <= MiB);
    }

    assert.deepEqual(joinChunks(chunks), bytes);
  });
}

void test('joinChunks of no chunk is zero bytes', () => {
  assert.equal(joinChunks([]).length, 0);
});

void test('a value round-trips through encodeJson and decodeJson', () => {
  const value = { text: 'héllo', list: [1, null, true], nested: { a: 'b' } };

  for (const failure of failures) {
    assert.deepEqual(decodeJson(encodeJson(value), failure), value);
  }
});

void test('encodeJson of undefined decodes to null', () => {
  const chunks = encodeJson(undefined);

  assert.ok(chunks.length >= 1, 'always at least one chunk');
  assert.equal(decodeJson(chunks, 'invalid_output'), null);
});

void test('a 4-byte character split across a chunk boundary decodes whole', () => {
  // `"` + (MiB - 3) × 'a' puts the emoji's 4 bytes across the 1 MiB boundary.
  const value = `${'a'.repeat(MiB - 3)}😀${'b'.repeat(10)}`;
  const chunks = encodeJson(value);

  assert.equal(chunks.length, 2);
  assert.equal(decodeJson(chunks, 'invalid_input'), value);

  // The same split made by hand.
  const text = utf8.encode(JSON.stringify(value));

  assert.equal(
    decodeJson([text.subarray(0, MiB - 1), text.subarray(MiB - 1)], 'invalid_output'),
    value,
  );
});

for (const failure of failures) {
  void test(`decodeJson fails with ${failure} for no chunk, invalid UTF-8 and non-JSON text`, () => {
    assert.throws(() => decodeJson([], failure), isCode(failure));
    assert.throws(
      () => decodeJson([new Uint8Array([0x22, 0xff, 0x22])], failure),
      isCode(failure),
    );
    assert.throws(() => decodeJson([utf8.encode('{')], failure), isCode(failure));
  });
}

void test('encodeJson of a value JSON cannot hold throws invalid_input', () => {
  const cycle: Record<string, unknown> = {};

  cycle.self = cycle;

  assert.throws(() => encodeJson(cycle), isCode('invalid_input'));
  assert.throws(() => encodeJson(1n), isCode('invalid_input'));
});
