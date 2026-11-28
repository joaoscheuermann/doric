// Stage-8 platform contracts (section 9): doric.notifications/v1,
// doric.windows/v1.lastPath, the host distribution members of
// doric.catalog/v1 and the environments widened by [S8-7].

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DoricNotificationsV1 } from '../src/contracts/index.js';
import {
  catalogManifestSchema,
  platformContracts,
} from '../src/contracts/platform.js';
import { platformSchemaDocuments } from '../src/index.js';
import { type Manifest, parseManifest } from '../src/runtime/manifest.js';

void test('doric.notifications/v1 is a desktopMain contract only (WP-10N), taking exactly a title and a body', () => {
  const spec = platformContracts['doric.notifications/v1'];

  assert.equal(DoricNotificationsV1.id, 'doric.notifications/v1');
  assert.deepEqual(spec.environments, ['desktopMain']);
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'Done', body: 'ok' }).success,
    true,
  );
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'Done' }).success,
    false,
  );
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'a', body: 'b', icon: 'x' })
      .success,
    false,
  );
});

void test('doric.windows/v1 lastPath answers a path or null for a key', () => {
  const { lastPath } = platformContracts['doric.windows/v1'].methods;

  assert.equal(lastPath.input.safeParse('workspace').success, true);
  assert.equal(lastPath.output.safeParse('/settings').success, true);
  assert.equal(lastPath.output.safeParse(null).success, true);
  assert.equal(lastPath.output.safeParse(undefined).success, false);
});

void test('catalog and diagnostics exist in every environment', () => {
  for (const id of ['doric.catalog/v1', 'doric.diagnostics/v1'] as const) {
    assert.deepEqual(platformContracts[id].environments, [
      'host',
      'desktopMain',
      'client',
    ]);
  }
});

void test('catalog artifact takes a lowercase SHA-256 only', () => {
  const { artifact } = platformContracts['doric.catalog/v1'].methods;

  assert.equal(
    artifact.input.safeParse({ sha256: 'a'.repeat(64) }).success,
    true,
  );
  assert.equal(
    artifact.input.safeParse({ sha256: 'A'.repeat(64) }).success,
    false,
  );
  assert.equal(artifact.input.safeParse({ sha256: 'abc' }).success, false);
});

void test('the platform schema documents include the new contract members', () => {
  const documents = platformSchemaDocuments();
  const notifications = documents.get('contracts/doric.notifications/v1.json');
  const windows = documents.get('contracts/doric.windows/v1.json');
  const catalog = documents.get('contracts/doric.catalog/v1.json');

  assert.ok(notifications !== undefined);
  assert.deepEqual(Object.keys(notifications.$defs as object).sort(), [
    'show.input',
    'show.output',
  ]);
  assert.ok(Object.hasOwn(windows?.$defs as object, 'lastPath.output'));
  assert.ok(Object.hasOwn(catalog?.$defs as object, 'watch.input'));
});

const publishedV1 = {
  manifestVersion: 1,
  id: 'git',
  version: '1.4.0',
  engines: { doric: '^1.0.0' },
  provides: ['git.commands/v1@1.3.0'],
  requires: ['tools/v1@^1.0.0'],
  optional: ['chat.views/v1'],
  host: { httpPrefix: '/git/' },
};

const publishedV2 = {
  manifestVersion: 2,
  id: 'files',
  version: '2.0.0',
  engines: { doric: '^2.0.0' },
  provides: ['files/v1@1.4.0'],
  host: { requires: ['tools/v1@^1.4.0'], optional: [], httpPrefix: '/files/' },
  client: { requires: ['ui/v1@^1.0.0'], optional: ['chat.views/v1'] },
  desktopScope: { 'files/v1': ['projectId'] },
};

void test('catalogManifestSchema accepts a published v1 and a published v2 manifest (G6)', () => {
  assert.deepEqual(catalogManifestSchema.parse(publishedV1), publishedV1);
  assert.deepEqual(catalogManifestSchema.parse(publishedV2), publishedV2);
});

void test('catalogManifestSchema refuses a v2 manifest without its part lists or with top-level lists', () => {
  const { host: _host, ...withoutHost } = publishedV2;
  const { client: _client, ...withoutClient } = publishedV2;
  const cases: Record<string, unknown> = {
    'without host': withoutHost,
    'without client': withoutClient,
    'with top-level requires': { ...publishedV2, requires: [] },
    'with a client part missing optional': {
      ...publishedV2,
      client: { requires: [] },
    },
    'with an unknown version': { ...publishedV2, manifestVersion: 3 },
  };

  for (const [name, document] of Object.entries(cases)) {
    assert.equal(
      catalogManifestSchema.safeParse(document).success,
      false,
      name,
    );
  }
});

// S62d3 gave manifests `host.assets` (section 14, "Assets"; D35), which
// `runtime/manifest.ts` accepts in both versions; the catalog publishes the
// validated manifest, so `catalogManifestSchema` accepts it too.

void test('catalogManifestSchema accepts host.assets in a v1 and a v2 manifest (D35)', () => {
  const v1 = {
    ...publishedV1,
    host: { httpPrefix: '/git/', assets: ['src/skills/*/SKILL.md'] },
  };
  const v2 = {
    ...publishedV2,
    host: {
      ...publishedV2.host,
      assets: ['src/host/skills/*.md', 'dist/sandbox/runner.mjs'],
    },
  };

  assert.deepEqual(catalogManifestSchema.parse(v1), v1);
  assert.deepEqual(catalogManifestSchema.parse(v2), v2);
});

void test('catalogManifestSchema still refuses an unknown host key or non-string assets', () => {
  const cases: Record<string, unknown> = {
    'v1 with an unknown host key': {
      ...publishedV1,
      host: { httpPrefix: '/git/', kind: 'sea' },
    },
    'v2 with an unknown host key': {
      ...publishedV2,
      host: { ...publishedV2.host, kind: 'sea' },
    },
    'v1 with non-string assets': {
      ...publishedV1,
      host: { assets: [1] },
    },
    'v2 with assets that are not an array': {
      ...publishedV2,
      host: { ...publishedV2.host, assets: 'src/skills/*/SKILL.md' },
    },
  };

  for (const [name, document] of Object.entries(cases)) {
    assert.equal(
      catalogManifestSchema.safeParse(document).success,
      false,
      name,
    );
  }
});

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Every `bundles/<group>/<name>/manifest.json`, by `<group>/<name>`. */
const sourceManifests = (): Map<string, unknown> => {
  const bundles = join(repositoryRoot, 'bundles');
  const found = new Map<string, unknown>();
  for (const group of readdirSync(bundles, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const bundle of readdirSync(join(bundles, group.name), {
      withFileTypes: true,
    })) {
      if (!bundle.isDirectory()) continue;
      const path = join(bundles, group.name, bundle.name, 'manifest.json');
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      found.set(`${group.name}/${bundle.name}`, JSON.parse(text));
    }
  }
  return found;
};

/**
 * `manifest` in the form `doric.catalog/v1` publishes it: a version 2 `host`
 * without `kind`, which the runtime defaults and the catalog leaves out.
 */
const published = (manifest: Manifest): unknown => {
  if (manifest.manifestVersion !== 2) {
    return manifest;
  }

  const { kind: _kind, ...host } = manifest.host;

  return { ...manifest, host };
};

void test('catalogManifestSchema accepts every bundle manifest of the repository in its published form', () => {
  const manifests = sourceManifests();
  const refused: string[] = [];

  assert.ok(manifests.size > 0);
  for (const [name, document] of manifests) {
    const { manifest } = parseManifest(document);
    const parsed = catalogManifestSchema.safeParse(published(manifest));
    if (!parsed.success) {
      refused.push(`${name}: ${parsed.error.message}`);
    }
  }

  assert.deepEqual(refused, []);
});
