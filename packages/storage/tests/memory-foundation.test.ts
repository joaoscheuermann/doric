import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type EmbeddedBundle, startHost } from 'bundle';
import {
  type HostContext,
  SecretsBackendV1,
  StorageBackendV1,
} from 'bundle/contracts';

import { createMemoryStore, memoryFoundation } from '../src/memory/index.js';

/** A core that only declares the two backends the real core requires. */
const testCore = (seen: string[]): EmbeddedBundle => ({
  manifest: {
    manifestVersion: 1,
    id: 'testcore',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [],
    requires: ['storage.backend/v1@^1.0.0', 'secrets.backend/v1@^1.0.0'],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'testcore', version: '1.0.0' },
    contracts: [],
  },
  host: {
    activate: ({ services }: HostContext) => {
      // A foundation contract is active before the core activates.
      services.whenAvailable(StorageBackendV1, () => {
        seen.push('storage.backend/v1');
      });
    },
  },
});

const boot = async (
  embedded: readonly EmbeddedBundle[],
  enabled: string[],
  providers: Record<string, string>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-foundation-'));
  const noop = () => undefined;
  const platform = await startHost({
    bundlesPath: root,
    composition: { core: 'testcore', enabled, providers },
    embedded,
    log: { info: noop, warn: noop, error: noop },
    sink: { write: noop },
  });

  return {
    platform,
    close: async () => {
      await platform.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
};

void test('the memory foundation, chosen in providers, serves both backends to the host', async () => {
  const seen: string[] = [];
  const store = createMemoryStore();
  const { platform, close } = await boot(
    [testCore(seen), memoryFoundation({ store, secrets: { rows: [] } })],
    ['testcore', 'memory'],
    { 'storage.backend/v1': 'memory', 'secrets.backend/v1': 'memory' },
  );

  try {
    assert.equal(platform.mode, 'normal');
    assert.deepEqual(seen, ['storage.backend/v1']);

    const identity = await platform.storageIdentity();

    assert.equal(identity?.storageGeneration, 1);
    assert.deepEqual(platform.catalog().storage, identity);

    const storage = platform.services.use(StorageBackendV1);

    await storage.commit({
      put: [{ type: 'test.note/v1', id: 'n1', value: { a: 1 } }],
    });
    assert.equal(
      (await storage.get({ type: 'test.note/v1', id: 'n1' }))?.revision,
      1,
    );
    assert.deepEqual(await platform.services.use(SecretsBackendV1).list(), []);
  } finally {
    await close();
  }

  // The store outlives the host: a second boot over it sees the same data.
  const again = await boot(
    [testCore([]), memoryFoundation({ store, id: 'memory-2' })],
    ['testcore', 'memory-2'],
    { 'storage.backend/v1': 'memory-2', 'secrets.backend/v1': 'memory-2' },
  );

  try {
    assert.equal(again.platform.mode, 'normal');
    assert.equal(
      (
        await again.platform.services
          .use(StorageBackendV1)
          .get({ type: 'test.note/v1', id: 'n1' })
      )?.revision,
      1,
    );
  } finally {
    await again.close();
  }
});

void test('the memory foundation must still be chosen in providers', async () => {
  const { platform, close } = await boot(
    [testCore([]), memoryFoundation()],
    ['testcore', 'memory'],
    {},
  );

  try {
    assert.equal(platform.mode, 'recovery');
  } finally {
    await close();
  }
});
