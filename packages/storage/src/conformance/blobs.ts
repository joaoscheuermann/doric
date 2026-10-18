import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { caseGroup } from './harness.js';
import { isCode, lastPosition, open } from './support.js';

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const blobs = caseGroup('blobs');

export const blobCases = [
  blobs(
    'B1',
    'putBlob answers the sha256 of the bytes and is idempotent',
    async (harness) => {
      const backend = await open(harness);
      const start = await lastPosition(backend);
      const bytes = Buffer.from('hello, blob', 'utf8');
      const encoded = bytes.toString('base64');
      const { hash } = await backend.putBlob(encoded);

      assert.match(hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(hash, sha256(bytes));
      assert.deepEqual(await backend.putBlob(encoded), { hash });
      assert.deepEqual(await (await open(harness)).putBlob(encoded), { hash });
      assert.equal(await backend.getBlob(hash), encoded);
      assert.deepEqual(await backend.putBlob(''), {
        hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });
      assert.equal(
        await backend.getBlob(
          'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        ),
        '',
      );
      // Blobs are not commits.
      assert.equal(await lastPosition(backend), start);
    },
  ),
  blobs(
    'B2',
    'every byte value, 0x00 included, round trips exactly',
    async (harness) => {
      const backend = await open(harness);
      const bytes = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
      const encoded = Buffer.from(bytes).toString('base64');
      const { hash } = await backend.putBlob(encoded);

      assert.equal(hash, sha256(bytes));

      const read = await (await open(harness)).getBlob(hash);

      assert.ok(read !== undefined);
      assert.deepEqual(new Uint8Array(Buffer.from(read, 'base64')), bytes);
      await assert.rejects(
        backend.putBlob('not base64!'),
        isCode('invalid_input'),
      );
    },
  ),
  blobs(
    'B3',
    'an unknown or malformed hash reads undefined',
    async (harness) => {
      const backend = await open(harness);

      assert.equal(
        await backend.getBlob(`sha256:${'0'.repeat(64)}`),
        undefined,
      );
      assert.equal(await backend.getBlob('md5:abc'), undefined);
      assert.equal(await backend.getBlob(''), undefined);
    },
  ),
  blobs('B4', 'a blob of several megabytes round trips', async (harness) => {
    const backend = await open(harness);
    const bytes = Uint8Array.from(
      { length: 6 * 1024 * 1024 },
      (_, index) => (index * 31) % 256,
    );
    const encoded = Buffer.from(bytes).toString('base64');
    const { hash } = await backend.putBlob(encoded);

    assert.equal(hash, sha256(bytes));
    assert.equal(await backend.getBlob(hash), encoded);
  }),
  blobs(
    'B5',
    'deleteBlob removes a blob, and an unknown hash is a no-op',
    async (harness) => {
      const backend = await open(harness);
      const encoded = Buffer.from('gone soon', 'utf8').toString('base64');
      const { hash } = await backend.putBlob(encoded);
      const kept = await backend.putBlob(
        Buffer.from('kept', 'utf8').toString('base64'),
      );

      await backend.deleteBlob(hash);
      await backend.deleteBlob(hash);
      await backend.deleteBlob('md5:abc');

      assert.equal(await (await open(harness)).getBlob(hash), undefined);
      assert.notEqual(await backend.getBlob(kept.hash), undefined);
    },
  ),
];
