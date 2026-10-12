import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { DistributionBundle } from 'bundle/runtime';

import { ArtifactCache } from '../src/platform/catalog/artifacts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const bundle = (
  id: string,
  files: Readonly<Record<string, string>>,
): DistributionBundle => ({
  id,
  version: '1.0.0',
  state: 'active',
  reasons: [],
  files: Object.entries(files).map(([path, content]) => ({
    path,
    sha256: sha(content),
    size: Buffer.byteLength(content),
  })),
  parts: { desktopMain: 'desktop/index.js' },
});

/** The host's artifact store: bytes by hash, with the requests it served. */
const host = (contents: readonly string[]) => {
  const byHash = new Map(contents.map((content) => [sha(content), content]));
  const requests: string[] = [];

  return {
    requests,
    fetch: async (hash: string) => {
      requests.push(hash);

      const content = byHash.get(hash);

      if (content === undefined) {
        throw new Error('not_found');
      }

      return new Uint8Array(Buffer.from(content));
    },
  };
};

let root: string;
let cache: ArtifactCache;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'doric-artifacts-'));
  cache = new ArtifactCache(
    join(root, 'bundles'),
    join(root, 'bundles', '.tmp'),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (id: string, path: string) =>
  readFile(join(root, 'bundles', `${id}@1.0.0`, path), 'utf8');

describe('verified artifact cache', () => {
  test('downloads a missing file, verifies it and keeps it', async () => {
    const probe = bundle('probe', {
      'desktop/index.js': 'export const a = 1;',
    });
    const store = host(['export const a = 1;']);

    const first = await cache.ensure([probe], store.fetch);
    const second = await cache.ensure([probe], store.fetch);

    assert.deepEqual(
      [
        first.downloaded,
        first.failed.length,
        second.verified,
        second.downloaded,
      ],
      [1, 0, 1, 0],
    );
    assert.equal(
      await read('probe', 'desktop/index.js'),
      'export const a = 1;',
    );
    assert.equal(store.requests.length, 1);
  });

  test('replaces a tampered cached file with the catalog’s bytes', async () => {
    const probe = bundle('probe', { 'desktop/index.js': 'good' });

    await mkdir(join(root, 'bundles', 'probe@1.0.0', 'desktop'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'bundles', 'probe@1.0.0', 'desktop', 'index.js'),
      'evil',
    );

    const result = await cache.ensure([probe], host(['good']).fetch);

    assert.equal(result.downloaded, 1);
    assert.equal(await read('probe', 'desktop/index.js'), 'good');
  });

  test('never writes bytes whose hash differs from the catalog', async () => {
    const probe = bundle('probe', { 'desktop/index.js': 'expected' });
    const result = await cache.ensure(
      [probe],
      async () => new Uint8Array(Buffer.from('something else')),
    );

    assert.deepEqual(
      result.failed.map(({ bundleId, path, reason, message }) => ({
        bundleId,
        path,
        reason,
        message,
      })),
      [
        {
          bundleId: 'probe',
          path: 'desktop/index.js',
          reason: 'hash_mismatch',
          message: 'artifact hash mismatch: desktop/index.js',
        },
      ],
    );
    await assert.rejects(
      stat(join(root, 'bundles', 'probe@1.0.0', 'desktop', 'index.js')),
    );
  });

  test('a write that cannot complete leaves no partial file in place', async () => {
    const probe = bundle('probe', { 'desktop/index.js': 'complete' });

    // The target path is a directory, so the final rename fails.
    await mkdir(
      join(root, 'bundles', 'probe@1.0.0', 'desktop', 'index.js', 'x'),
      {
        recursive: true,
      },
    );

    const result = await cache.ensure([probe], host(['complete']).fetch);

    assert.equal(result.failed[0]?.reason, 'download_failed');
    assert.deepEqual(await readdir(join(root, 'bundles', '.tmp')), []);
  });

  test('serves only listed files of retained generations', async () => {
    const probe = bundle('probe', { 'client/index.js': 'c' });

    await cache.ensure([probe], host(['c']).fetch);

    assert.equal(cache.file('probe', '1.0.0', 'client/index.js'), undefined);
    cache.retain(4, [probe]);
    assert.equal(
      cache.file('probe', '1.0.0', 'client/index.js'),
      join(root, 'bundles', 'probe@1.0.0', 'client', 'index.js'),
    );
    assert.equal(cache.file('probe', '1.0.0', 'client/other.js'), undefined);
    cache.release(4);
    assert.equal(cache.file('probe', '1.0.0', 'client/index.js'), undefined);
  });

  test('collect keeps retained generations and kept bundles and deletes the rest', async () => {
    const kept = bundle('kept', { 'desktop/index.js': 'k' });
    const retained = bundle('live', { 'desktop/index.js': 'l' });
    const stale = bundle('stale', { 'desktop/index.js': 's' });

    await cache.ensure([kept, retained, stale], host(['k', 'l', 's']).fetch);
    cache.retain(2, [retained]);
    await cache.collect([kept]);

    assert.deepEqual((await readdir(join(root, 'bundles'))).sort(), [
      'kept@1.0.0',
      'live@1.0.0',
    ]);
  });
});
