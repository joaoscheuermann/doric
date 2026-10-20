import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { checkRecording, recordActivation } from 'bundle';
import {
  type CatalogCandidate,
  descriptorSchema,
  type ManifestV1,
  manifestV1Schema,
  resolveEnvironment,
} from 'bundle/runtime';

import { activate } from '../src/host/index.js';

/*
 * The runtime's activation (design 57 §13.1, stage 5 "Activation"): the
 * manifest and built descriptor are valid, activation provides and defines
 * exactly what the manifest declares, the host activation order of §1.2 has
 * no cycle, and a second `runtime/v1` provider is quarantined.
 */

const manifestOf = async (dir: string): Promise<ManifestV1> =>
  manifestV1Schema.parse(
    JSON.parse(
      await readFile(
        `bundles/${dir === 'core' ? 'foundation' : dir === 'runtime' ? 'runtime' : 'features'}/${dir}/manifest.json`,
        'utf8',
      ),
    ),
  );

const idOf = (entry: string) => entry.slice(0, entry.indexOf('@'));

/** A catalog candidate whose descriptor lists every provided contract. */
const candidate = (manifest: ManifestV1): CatalogCandidate => ({
  id: manifest.id,
  source: { kind: 'installed', dir: `/bundles/${manifest.id}` },
  manifest,
  descriptor: descriptorSchema.parse({
    descriptorVersion: 1,
    bundle: { id: manifest.id, version: manifest.version },
    contracts: manifest.provides.map((entry) => ({
      id: idOf(entry),
      version: entry.slice(entry.indexOf('@') + 1),
      kind: 'service',
      environment: 'host',
      cardinality: 'one',
      local: false,
      schema: `schemas/${idOf(entry)}.json`,
    })),
  }),
  errors: [],
});

/** A stand-in provider of contracts other bundles own. */
const provider = (id: string, provides: readonly string[]) =>
  manifestV1Schema.parse({
    manifestVersion: 1,
    id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides,
    requires: [],
  });

void test('activation provides and defines exactly what the manifest declares', async () => {
  const manifest = await manifestOf('runtime');
  const recorded = await recordActivation({
    manifest,
    environment: 'host',
    activate,
  });

  assert.deepEqual(checkRecording(manifest, recorded), []);
  assert.deepEqual(
    [...new Set(recorded.map(({ id }) => id))].sort(),
    manifest.provides.map(idOf).sort(),
  );
});

void test('the built descriptor lists every provided contract on the host', async () => {
  const manifest = await manifestOf('runtime');
  const descriptor = descriptorSchema.parse(
    JSON.parse(
      await readFile('bundles/runtime/runtime/dist/contracts.json', 'utf8'),
    ),
  );

  assert.deepEqual(descriptor.bundle, {
    id: manifest.id,
    version: manifest.version,
  });
  assert.deepEqual(
    descriptor.contracts.map(({ id }) => id).sort(),
    manifest.provides.map(idOf).sort(),
  );
  assert.ok(
    descriptor.contracts.every(({ environment }) => environment === 'host'),
  );
});

void test('the runtime activates after its providers and before the bundles that require it', async () => {
  const core = await manifestOf('core');
  const runtime = await manifestOf('runtime');
  const candidates = [
    candidate(core),
    candidate(runtime),
    candidate(await manifestOf('files')),
    candidate(await manifestOf('git')),
    candidate(await manifestOf('threads')),
    candidate(provider('default', ['executor/v1@1.0.0'])),
    candidate(provider('docker', ['sandbox/v1@1.0.0'])),
    // The window surfaces the stage-10 client parts of files and git require.
    candidate(
      provider('desktop-surfaces', [
        'layout.workspace/v1@1.1.0',
        'layout.panel/v1@1.0.0',
        'layout.tabs/v1@1.1.0',
        'settings.config/v1@1.0.0',
      ]),
    ),
    candidate(provider('host-config', ['host-config/v1@1.0.0'])),
    candidate(
      provider('storage-backend', [
        'storage.backend/v1@1.0.0',
        'secrets.backend/v1@1.0.0',
      ]),
    ),
  ];
  const resolved = resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: candidates.map(({ id }) => id),
        providers: {
          'storage.backend/v1': 'storage-backend',
          'secrets.backend/v1': 'storage-backend',
        },
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );
  const state = (id: string) =>
    resolved.entries.find((entry) => entry.id === id);

  assert.deepEqual(state('runtime')?.reasons, []);
  const position = (id: string) => resolved.order.indexOf(id);
  for (const before of ['core', 'default', 'docker', 'host-config'])
    assert.ok(position(before) < position('runtime'), before);
  for (const after of ['files', 'git', 'threads'])
    assert.ok(position('runtime') < position(after), after);
  // files, git and threads keep their lexical order, so tools keep theirs.
  assert.deepEqual(
    resolved.order.filter((id) => ['files', 'git', 'threads'].includes(id)),
    ['files', 'git', 'threads'],
  );
});

void test('a second provider of runtime/v1 is quarantined without a choice', async () => {
  const core = await manifestOf('core');
  const runtime = await manifestOf('runtime');
  const other = provider('runtime-copy', ['runtime/v1@1.0.0']);
  const candidates = [
    candidate(core),
    candidate(runtime),
    candidate(other),
    candidate(provider('default', ['executor/v1@1.0.0'])),
    candidate(provider('docker', ['sandbox/v1@1.0.0'])),
    candidate(provider('host-config', ['host-config/v1@1.0.0'])),
    candidate(
      provider('storage-backend', [
        'storage.backend/v1@1.0.0',
        'secrets.backend/v1@1.0.0',
      ]),
    ),
  ];
  const resolved = resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: candidates.map(({ id }) => id),
        providers: {
          'storage.backend/v1': 'storage-backend',
          'secrets.backend/v1': 'storage-backend',
        },
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );
  const codes = (id: string) =>
    resolved.entries
      .find((entry) => entry.id === id)
      ?.reasons.map(({ code }) => code) ?? [];

  assert.ok(codes('runtime-copy').includes('unchosen_provider'));
  assert.deepEqual(codes('runtime'), []);
  assert.deepEqual(
    resolved.contracts
      .find(({ id }) => id === 'runtime/v1')
      ?.providers.map(({ bundleId }) => bundleId),
    ['runtime'],
  );
});
