import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DoricCatalogV1,
  type HostContext,
  isContractError,
  StorageBackendV1,
  type StorageIdentity,
  storageBackendMethods,
} from '../src/contracts/index.js';
import { basicProvider } from './support/basic.js';
import { embedded, manifest, withRoot } from './support/fixtures.js';
import { start } from './support/host.js';
import { minimalCore } from './support/minimal-core.js';

const identity: StorageIdentity = {
  hostId: '0b8f4d1e-3c2a-4f6b-9a7d-5e1c2b3a4d5f',
  storageGeneration: 1,
};

/** A storage.backend/v1 foundation whose identity() answers from a queue. */
const backend = (answers: (() => unknown)[]) => {
  let calls = 0;
  const bundle = embedded(
    manifest('membackend', { provides: ['storage.backend/v1@1.0.0'] }),
    ({ services }: HostContext) => {
      services.provide(
        basicProvider(StorageBackendV1.id, storageBackendMethods, {
          identity: async () => {
            calls += 1;
            await Promise.resolve();

            const answer = answers.shift();

            if (answer === undefined) {
              throw new Error('no answer queued');
            }

            return answer();
          },
        }),
      );
    },
  );

  return { bundle, calls: () => calls };
};

const startWith = (
  root: string,
  bundle: ReturnType<typeof backend>['bundle'],
) =>
  start({
    bundlesPath: root,
    composition: {
      enabled: ['mincore', 'membackend'],
      providers: { 'storage.backend/v1': 'membackend' },
    },
    embedded: [
      minimalCore({ requires: ['storage.backend/v1@^1.0.0'] }),
      bundle,
    ],
  });

void test('the catalog publishes the storage identity once the host resolved it', async () => {
  await withRoot(async (root) => {
    const fake = backend([() => identity]);
    const { platform } = await startWith(root, fake.bundle);

    assert.equal(platform.mode, 'normal');
    assert.equal(platform.catalog().storage, undefined);

    assert.deepEqual(await platform.storageIdentity(), identity);
    assert.deepEqual(platform.catalog().storage, identity);
    assert.deepEqual(
      platform.services.use(DoricCatalogV1).get().storage,
      identity,
    );

    await platform.stop();
  });
});

void test('a resolved identity is kept: later and concurrent calls ask the backend once', async () => {
  await withRoot(async (root) => {
    const fake = backend([
      () => identity,
      () => ({ ...identity, storageGeneration: 2 }),
    ]);
    const { platform } = await startWith(root, fake.bundle);

    const [first, second] = await Promise.all([
      platform.storageIdentity(),
      platform.storageIdentity(),
    ]);

    assert.deepEqual(first, identity);
    assert.deepEqual(second, identity);
    assert.deepEqual(await platform.storageIdentity(), identity);
    assert.equal(fake.calls(), 1);

    await platform.stop();
  });
});

void test('a failed identity is not kept: the next call asks the backend again', async () => {
  await withRoot(async (root) => {
    const fake = backend([
      () => {
        throw new Error('database unreachable');
      },
      () => identity,
    ]);
    const { platform } = await startWith(root, fake.bundle);

    await assert.rejects(platform.storageIdentity(), /database unreachable/);
    assert.equal(platform.catalog().storage, undefined);

    assert.deepEqual(await platform.storageIdentity(), identity);
    assert.deepEqual(platform.catalog().storage, identity);

    await platform.stop();
  });
});

void test('an identity that breaks the schema is refused and not published', async () => {
  await withRoot(async (root) => {
    const fake = backend([() => ({ hostId: 'host-1', storageGeneration: 1 })]);
    const { platform } = await startWith(root, fake.bundle);

    await assert.rejects(
      platform.storageIdentity(),
      (error) => isContractError(error) && error.code === 'invalid_output',
    );
    assert.equal(platform.catalog().storage, undefined);

    await platform.stop();
  });
});

void test('without a storage.backend/v1 provider there is no identity', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [minimalCore()],
    });

    assert.equal(platform.mode, 'normal');
    assert.equal(await platform.storageIdentity(), undefined);
    assert.equal('storage' in platform.catalog(), false);

    await platform.stop();
  });
});
