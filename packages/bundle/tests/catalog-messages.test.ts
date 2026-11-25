// The `doric.catalog/v1` messages of the catalog values the desktop reads
// (groupE S63a §2.2): a snapshot and a distribution catalog survive the trip
// to their message and back, and a message the catalog schemas refuse throws
// `invalid_output` naming the field.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create } from '@bufbuild/protobuf';

import { ContractError } from '../src/contracts/error.js';
import {
  CatalogSnapshotSchema,
  DistributionResponseSchema,
} from '../src/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import type {
  CatalogManifest,
  CatalogSnapshot,
  DistributionCatalog,
} from '../src/contracts/platform.js';
import {
  catalogSnapshotMessage,
  catalogSnapshotOf,
  distributionCatalogOf,
  distributionMessage,
} from '../src/runtime/index.js';

const chatManifest: CatalogManifest = {
  manifestVersion: 2,
  id: 'chat',
  version: '1.2.0',
  engines: { doric: '^1.0.0' },
  provides: ['chat/v1@1.0.0'],
  host: {
    requires: ['settings/v1@^1.0.0'],
    optional: [],
    httpPrefix: '/chat/',
  },
  client: { requires: ['chat/v1@^1.0.0'], optional: ['models/v1@^1.0.0'] },
  desktopScope: { 'chat/v1': ['threadId'] },
  description: 'Threads and messages.',
};

const snapshot: CatalogSnapshot = {
  generation: 3,
  composition: {
    core: 'core',
    enabled: ['core', 'chat', 'broken'],
    providers: { 'chat/v1': 'chat' },
  },
  bundles: [
    {
      id: 'core',
      version: '1.0.0',
      state: 'active',
      phase: 'core',
      reasons: [],
    },
    {
      id: 'chat',
      version: '1.2.0',
      description: 'Threads and messages.',
      state: 'active',
      phase: 'others',
      manifest: chatManifest,
      reasons: [],
    },
    {
      id: 'broken',
      version: '0.1.0',
      state: 'quarantined',
      reasons: [
        {
          code: 'missing_dependency',
          message: 'requires tools/v1, which no bundle provides',
          contract: 'tools/v1',
        },
        { code: 'process_failed', message: 'exited 5' },
      ],
    },
  ],
  order: ['core', 'chat'],
  contracts: [
    {
      id: 'chat/v1',
      environment: 'host',
      cardinality: 'one',
      providers: [
        { bundleId: 'chat', version: '1.0.0', bundleVersion: '1.2.0' },
      ],
    },
  ],
  storage: {
    hostId: '0b7e3c1a-5d2f-4e8a-9c6b-7a1d2e3f4b5c',
    storageGeneration: 4,
  },
};

const sha = (digit: string): string => digit.repeat(64);

const distribution: DistributionCatalog = {
  generation: 3,
  hostBoot: 'boot-7f3c',
  platformVersion: '1.4.0',
  composition: snapshot.composition,
  storage: {
    hostId: '0b7e3c1a-5d2f-4e8a-9c6b-7a1d2e3f4b5c',
    storageGeneration: 4,
  },
  host: snapshot,
  bundles: [
    {
      id: 'chat',
      version: '1.2.0',
      state: 'active',
      reasons: [],
      manifest: chatManifest,
      descriptor: {
        contracts: [{ id: 'chat/v1', version: '1.0.0' }],
        nested: { flag: true, count: 2, nothing: null },
      },
      files: [
        { path: 'client/index.js', sha256: sha('a'), size: 120 },
        { path: 'client/styles.css', sha256: sha('b'), size: 0 },
        { path: 'contracts/index.js', sha256: sha('c'), size: 3_000_000 },
        { path: 'desktop/index.js', sha256: sha('d'), size: 64 },
        { path: 'manifest.json', sha256: sha('e'), size: 400 },
      ],
      parts: {
        desktopMain: 'desktop/index.js',
        client: 'client/index.js',
        clientStyles: 'client/styles.css',
        contracts: 'contracts/index.js',
      },
    },
    {
      id: 'broken',
      version: '0.1.0',
      state: 'quarantined',
      reasons: [{ code: 'process_failed', message: 'exited 5' }],
      files: [],
      parts: {},
    },
  ],
};

/** Asserts `run` throws `ContractError('invalid_output')` naming `field`. */
const assertInvalidOutput = (run: () => unknown, field: RegExp): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(
      error instanceof ContractError,
      `expected a ContractError: ${String(error)}`,
    );
    assert.equal(error.code, 'invalid_output');
    assert.match(error.message, field);

    return true;
  });
};

describe('catalog snapshot messages', () => {
  test('catalogSnapshotOf(catalogSnapshotMessage(s)) deep-equals s', () => {
    assert.deepEqual(
      catalogSnapshotOf(catalogSnapshotMessage(snapshot)),
      snapshot,
    );
  });

  test('a message whose bundle state is "lost" throws invalid_output naming the field', () => {
    const message = create(CatalogSnapshotSchema, {
      generation: 1,
      composition: { core: 'core', enabled: ['core'], providers: {} },
      bundles: [{ id: 'core', version: '1.0.0', state: 'lost', reasons: [] }],
      order: ['core'],
      contracts: [],
    });

    assertInvalidOutput(() => catalogSnapshotOf(message), /state/);
  });
});

describe('distribution messages', () => {
  test('distributionCatalogOf(distributionMessage(c)) deep-equals c, with storage, reasons, manifest, descriptor and all four parts', () => {
    assert.deepEqual(
      distributionCatalogOf(distributionMessage(distribution)),
      distribution,
    );
  });

  test('file sizes are numbers in the message', () => {
    const message = distributionMessage(distribution);

    assert.deepEqual(
      message.bundles[0]?.files.map(({ size }) => size),
      [120, 0, 3_000_000, 64, 400],
    );
  });

  test('a message whose bundle state is "lost" throws invalid_output naming the field', () => {
    const message = create(DistributionResponseSchema, {
      generation: 1,
      hostBoot: 'boot',
      platformVersion: '1.0.0',
      composition: { core: 'core', enabled: ['core'], providers: {} },
      host: {
        generation: 1,
        composition: { core: 'core', enabled: ['core'], providers: {} },
        bundles: [],
        order: [],
        contracts: [],
      },
      bundles: [
        {
          id: 'core',
          version: '1.0.0',
          state: 'lost',
          reasons: [],
          files: [],
          parts: {},
        },
      ],
    });

    assertInvalidOutput(() => distributionCatalogOf(message), /state/);
  });
});
