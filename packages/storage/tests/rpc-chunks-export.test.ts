// One chunk codec behind two specifiers (phase 3, slice S62b, A72, test 8):
// `storage/rpc/chunks` exports `src/rpc/chunks.ts` alone, so
// `runtime/contracts` can use the codec without the storage adapters and
// their Node modules; `storage/rpc` keeps re-exporting the same module, so
// both specifiers give the same bindings.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import * as rpc from 'storage/rpc';
import * as chunks from 'storage/rpc/chunks';

describe('S62b: storage/rpc/chunks', () => {
  test('gives the same codec bindings as storage/rpc', () => {
    assert.equal(chunks.encodeJson, rpc.encodeJson);
    assert.equal(chunks.decodeJson, rpc.decodeJson);
    assert.equal(chunks.chunkBytes, rpc.chunkBytes);
    assert.equal(chunks.joinChunks, rpc.joinChunks);
    assert.equal(chunks.maxChunkBytes, rpc.maxChunkBytes);
  });

  test('exports the chunk codec alone, without the storage adapters', () => {
    assert.deepEqual(Object.keys(chunks).sort(), [
      'chunkBytes',
      'decodeJson',
      'encodeJson',
      'joinChunks',
      'maxChunkBytes',
    ]);
  });
});
