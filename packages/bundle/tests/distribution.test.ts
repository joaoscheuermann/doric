// The host distribution catalog (stage 8, 11.1 and 19.2): the host hashes
// the files the desktop may need, and the desktop resolves its environments
// from the catalog with the host-side quarantines and disabled bundles
// [S8-8]. Real bundle directories on disk.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCatalog,
  discoverBundles,
  distributionFiles,
  distributionFor,
  statesOf,
} from '../src/index.js';
import {
  candidatesFromDistribution,
  compositionFromDistribution,
  DiagnosticsStore,
  type DistributionCatalog,
  distributionCatalogSchema,
  PLATFORM_VERSION,
  resolveEnvironment,
} from '../src/runtime/index.js';
import {
  descriptorFor,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';

const HOST_ID = '6f1c1c43-55a5-4c3e-9d0a-1f7d3cb7a6d1';

const alphaFiles = {
  'host/index.js': 'export const activate = () => undefined;\n',
  'desktop/index.js': 'export const activate = () => undefined;\n',
  'client/index.js': 'export const activate = () => undefined;\n',
  'client/styles.css': '.a{color:red}\n',
  'contracts/index.js': 'export const x = 1;\n',
  'contracts/index.d.ts': 'export declare const x: number;\n',
  'schemas/alpha.api/v1.json': '{}\n',
  'skills/01/SKILL.md': '# not distributed\n',
};

const writeInstalled = async (root: string) => {
  const bundles = join(root, 'bundles');
  const alpha = manifest('alpha');
  const beta = manifest('beta', { engines: '^2.0.0' });
  const gamma = manifest('gamma');

  await writeBundle(bundles, 'alpha', {
    manifest: alpha,
    descriptor: descriptorFor(alpha),
    files: alphaFiles,
  });
  await writeBundle(bundles, 'beta', {
    manifest: beta,
    descriptor: descriptorFor(beta),
    files: { 'desktop/index.js': 'export const activate = () => {};\n' },
  });
  await writeBundle(bundles, 'gamma', {
    manifest: gamma,
    descriptor: descriptorFor(gamma),
  });

  return bundles;
};

const hostDistribution = async (bundles: string) => {
  const resolved = buildCatalog({
    installed: await discoverBundles(bundles),
    embedded: [],
    composition: { core: 'alpha', enabled: ['alpha', 'beta'], providers: {} },
    platformVersion: PLATFORM_VERSION,
    generation: 3,
  });
  const diagnostics = new DiagnosticsStore({ generation: 3 });

  diagnostics.load(resolved);

  return distributionFor({
    resolved,
    states: statesOf(diagnostics.snapshot()),
    hostBoot: 'boot-1',
    platformVersion: PLATFORM_VERSION,
    storage: { hostId: HOST_ID, storageGeneration: 2 },
  });
};

const sha256 = (bytes: string) =>
  createHash('sha256').update(bytes).digest('hex');

void test('the host lists and hashes only the files the desktop may need', async () => {
  await withRoot(async (root) => {
    const bundles = await writeInstalled(root);
    const files = await distributionFiles(join(bundles, 'alpha'));

    assert.deepEqual(
      files.map((file) => file.path),
      [
        'client/index.js',
        'client/styles.css',
        'contracts.json',
        'contracts/index.js',
        'desktop/index.js',
        'manifest.json',
        'schemas/alpha.api/v1.json',
      ],
    );

    for (const file of files) {
      const bytes = await readFile(join(bundles, 'alpha', file.path), 'utf8');

      assert.equal(file.sha256, sha256(bytes), file.path);
      assert.equal(file.size, Buffer.byteLength(bytes), file.path);
    }
  });
});

void test('the host also lists the modules its distributed contracts import', async () => {
  await withRoot(async (root) => {
    const delta = manifest('delta');

    await writeBundle(join(root, 'bundles'), 'delta', {
      manifest: delta,
      descriptor: descriptorFor(delta),
      files: {
        'contracts/index.js':
          "export { fill } from '../host/models/catalog.js';\nexport * from './hooks.js';\n",
        'contracts/hooks.js': 'export const hooks = 1;\n',
        'host/models/catalog.js': "import { x } from '../util.js';\nexport const fill = x;\n",
        'host/util.js': 'export const x = 1;\n',
        'host/index.js': 'export const activate = () => undefined;\n',
      },
    });

    const files = await distributionFiles(join(root, 'bundles', 'delta'));

    assert.deepEqual(
      files.map((file) => file.path),
      [
        'contracts.json',
        'contracts/hooks.js',
        'contracts/index.js',
        'host/models/catalog.js',
        'host/util.js',
        'manifest.json',
      ],
    );
  });
});

void test('the distribution catalog carries the host generation, identity, parts and states', async () => {
  await withRoot(async (root) => {
    const catalog = await hostDistribution(await writeInstalled(root));

    assert.deepEqual(distributionCatalogSchema.parse(catalog), catalog);
    assert.equal(catalog.generation, 3);
    assert.equal(catalog.hostBoot, 'boot-1');
    assert.deepEqual(catalog.storage, {
      hostId: HOST_ID,
      storageGeneration: 2,
    });
    assert.deepEqual(catalog.host.storage, catalog.storage);

    const byId = new Map(catalog.bundles.map((bundle) => [bundle.id, bundle]));

    assert.deepEqual(byId.get('alpha')?.parts, {
      desktopMain: 'desktop/index.js',
      client: 'client/index.js',
      clientStyles: 'client/styles.css',
      contracts: 'contracts/index.js',
    });
    assert.equal(byId.get('alpha')?.state, 'inactive');
    assert.equal(byId.get('beta')?.state, 'quarantined');
    assert.deepEqual(
      byId.get('beta')?.reasons.map((reason) => reason.code),
      ['engines_unsatisfied'],
    );
    assert.equal(byId.get('gamma')?.state, 'disabled');
  });
});

void test('the desktop resolution keeps host quarantines and leaves disabled bundles out', async () => {
  await withRoot(async (root) => {
    const hosted = await hostDistribution(await writeInstalled(root));
    // A host override that disabled gamma although it is listed as enabled.
    const catalog: DistributionCatalog = {
      ...hosted,
      composition: {
        ...hosted.composition,
        enabled: ['alpha', 'beta', 'gamma'],
      },
    };
    const composition = compositionFromDistribution(catalog);

    assert.deepEqual(composition.enabled, ['alpha', 'beta']);

    const desktop = resolveEnvironment(
      {
        candidates: candidatesFromDistribution(catalog),
        composition,
        platformVersion: PLATFORM_VERSION,
        generation: 1,
      },
      'desktopMain',
    );
    const states = Object.fromEntries(
      desktop.entries.map((entry) => [
        entry.id,
        [entry.state, entry.reasons.map((reason) => reason.code)],
      ]),
    );

    assert.deepEqual(states, {
      alpha: ['scheduled', []],
      beta: ['quarantined', ['engines_unsatisfied']],
      gamma: ['disabled', []],
    });
  });
});

void test('a distributed bundle with an unreadable manifest or descriptor is quarantined', () => {
  const base = {
    version: '1.0.0',
    state: 'inactive' as const,
    reasons: [],
    files: [],
    parts: {},
  };
  const candidates = candidatesFromDistribution({
    generation: 1,
    hostBoot: 'b',
    platformVersion: PLATFORM_VERSION,
    composition: { core: 'a', enabled: ['a'], providers: {} },
    host: {
      generation: 1,
      composition: { core: 'a', enabled: ['a'], providers: {} },
      bundles: [],
      order: [],
      contracts: [],
    },
    bundles: [
      { ...base, id: 'nomanifest' },
      {
        ...base,
        id: 'badDescriptor',
        manifest: {
          manifestVersion: 1,
          id: 'baddescriptor',
          version: '1.0.0',
          engines: { doric: '^1.0.0' },
          provides: [],
          requires: [],
        },
        descriptor: { descriptorVersion: 9 },
      },
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.id,
      candidate.manifest === undefined,
      candidate.errors.map((reason) => reason.code),
    ]),
    [
      ['nomanifest', true, ['invalid_manifest']],
      ['baddescriptor', false, ['invalid_descriptor']],
    ],
  );
});
