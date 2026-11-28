/**
 * Blobs and health over `storage/v2` (T4.3): v1's B1–B5 on bytes, where
 * v1 took and answered base64 text, and `T4.3-health`, v1's H1 on
 * `StorageHealth`, served by the engine since S78b. Not ported: B1's
 * "blobs are not commits", read from v1's feed position, which `Storage`
 * does not expose; B2's malformed base64, which bytes cannot be; H2, since
 * `Storage` has no `identity()`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { caseGroup, type V2Case } from './harness.js';

const blobs = caseGroup('blobs');
const health = caseGroup('health');

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The hash of no bytes. */
const emptyHash =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The chunks `getBlob` answers, joined; `undefined` when it answers so. */
const joined = async (
  answer: AsyncIterable<Uint8Array> | undefined,
): Promise<Buffer | undefined> => {
  if (answer === undefined) {
    return undefined;
  }

  const parts: Uint8Array[] = [];

  for await (const part of answer) {
    parts.push(part);
  }

  return Buffer.concat(parts);
};

/** `bytes` as an iterable of pieces of at most `size` bytes. */
async function* piecesOf(
  bytes: Uint8Array,
  size: number,
): AsyncIterable<Uint8Array> {
  for (let start = 0; start < bytes.length; start += size) {
    yield await Promise.resolve(bytes.subarray(start, start + size));
  }
}

/**
 * The cases, in run order: group `blobs`, B1–B5, then group `health`,
 * `T4.3-health`.
 */
export const blobCases: readonly V2Case[] = Object.freeze([
  blobs(
    'B1',
    'putBlob answers the sha256 of the bytes and is idempotent',
    async (harness) => {
      const storage = await harness.open();
      const bytes = Buffer.from('hello, blob', 'utf8');
      const { hash } = await storage.putBlob(bytes);

      assert.match(hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(hash, sha256(bytes));
      assert.deepEqual(await storage.putBlob(bytes), { hash });
      assert.deepEqual(await (await harness.open()).putBlob(bytes), { hash });
      assert.deepEqual(await joined(await storage.getBlob(hash)), bytes);
      assert.deepEqual(await storage.putBlob(new Uint8Array()), {
        hash: emptyHash,
      });
      assert.deepEqual(
        await joined(await storage.getBlob(emptyHash)),
        Buffer.alloc(0),
      );
    },
  ),
  blobs(
    'B2',
    'every byte value, 0x00 included, round trips exactly, whole or in pieces',
    async (harness) => {
      const storage = await harness.open();
      const bytes = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
      const { hash } = await storage.putBlob(bytes);

      assert.equal(hash, sha256(bytes));
      assert.deepEqual(
        await joined(await (await harness.open()).getBlob(hash)),
        Buffer.from(bytes),
      );
      // The same bytes in pieces are the same blob.
      assert.deepEqual(await storage.putBlob(piecesOf(bytes, 100)), { hash });
    },
  ),
  blobs(
    'B3',
    'an unknown or malformed hash reads undefined',
    async (harness) => {
      const storage = await harness.open();

      assert.equal(
        await storage.getBlob(`sha256:${'0'.repeat(64)}`),
        undefined,
      );
      assert.equal(await storage.getBlob('md5:abc'), undefined);
      assert.equal(await storage.getBlob(''), undefined);
    },
  ),
  blobs('B4', 'a blob of several megabytes round trips', async (harness) => {
    const storage = await harness.open();
    const bytes = Uint8Array.from(
      { length: 6 * 1024 * 1024 },
      (_, index) => (index * 31) % 256,
    );
    const { hash } = await storage.putBlob(bytes);

    assert.equal(hash, sha256(bytes));
    assert.ok(
      (await joined(await storage.getBlob(hash)))?.equals(bytes),
      'the blob reads back byte for byte',
    );
  }),
  blobs(
    'B5',
    'deleteBlob removes a blob, and an unknown hash is a no-op',
    async (harness) => {
      const storage = await harness.open();
      const { hash } = await storage.putBlob(Buffer.from('gone soon', 'utf8'));
      const kept = await storage.putBlob(Buffer.from('kept', 'utf8'));

      await storage.deleteBlob(hash);
      await storage.deleteBlob(hash);
      await storage.deleteBlob('md5:abc');

      assert.equal(await (await harness.open()).getBlob(hash), undefined);
      assert.deepEqual(
        await joined(await storage.getBlob(kept.hash)),
        Buffer.from('kept', 'utf8'),
      );
    },
  ),
  health(
    'T4.3-health',
    "health answers the filesystem's measurements in today's shape",
    async (harness) => {
      const report = await (await harness.open()).health();

      if (report.status === 'unavailable') {
        // A disk that cannot be measured has no `disk`.
        assert.deepEqual(report, {
          status: 'unavailable',
          writable: false,
          reason: 'storage_unmeasurable',
        });

        return;
      }

      assert.equal(report.status, 'ok');
      assert.equal(typeof report.writable, 'boolean');
      assert.ok(report.disk !== undefined, 'a measured disk is reported');
      assert.ok(Number.isInteger(report.disk.blocks) && report.disk.blocks > 0);
      assert.ok(
        Number.isInteger(report.disk.availableBlocks) &&
          report.disk.availableBlocks >= 0 &&
          report.disk.availableBlocks <= report.disk.blocks,
      );
    },
  ),
]);
