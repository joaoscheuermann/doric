import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  type CatalogCandidate,
  descriptorSchema,
  type ManifestV1,
  manifestV1Schema,
  PLATFORM_VERSION,
  resolveEnvironment,
} from 'bundle/runtime';

/*
 * The runtime's place in the catalog (design 57 §13.1, stage 5 "Activation"):
 * the built descriptor is valid, the host activation order of §1.2 has no
 * cycle, and a second `runtime/v2` provider is quarantined. These cases came
 * from `activation.test.ts` when the kernel entry went (S68d, X3); its
 * recorded-activation case is covered by `host-build.test.ts` 29 and 30 and
 * `runtime-contracts.test.ts`' manifest case.
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

void test('the built descriptor lists runtime.records/v1 on the client and every other provided contract on the host', async () => {
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
  // The records mirror is the client part's; every other contract is the host's.
  assert.deepEqual(
    descriptor.contracts
      .filter(({ environment }) => environment === 'client')
      .map(({ id }) => id),
    ['runtime.records/v1'],
  );
  assert.ok(
    descriptor.contracts
      .filter(({ id }) => id !== 'runtime.records/v1')
      .every(({ environment }) => environment === 'host'),
  );
});

void test('the built descriptor lists executor.session/v1@1.0.0 on the host, which the host part serves', async () => {
  const descriptor = descriptorSchema.parse(
    JSON.parse(
      await readFile('bundles/runtime/runtime/dist/contracts.json', 'utf8'),
    ),
  );

  assert.deepEqual(
    descriptor.contracts
      .filter(({ id }) => id === 'executor.session/v1')
      .map(({ version, environment }) => [version, environment]),
    [['1.0.0', 'host']],
  );
});

void test('the runtime activates after its providers and before the bundles that require it, default included', async () => {
  const core = await manifestOf('core');
  const runtime = await manifestOf('runtime');
  const candidates = [
    candidate(core),
    candidate(runtime),
    candidate(await manifestOf('files')),
    candidate(await manifestOf('git')),
    candidate(await manifestOf('threads')),
    // default provides executor/v1, which runtime lists as optional, and
    // requires executor.session/v1, which runtime provides (S62c).
    candidate(
      manifestV1Schema.parse({
        manifestVersion: 1,
        id: 'default',
        version: '1.0.0',
        engines: { doric: '^1.0.0' },
        provides: ['executor/v1@1.6.0'],
        requires: ['executor.session/v1@^1.0.0'],
      }),
    ),
    candidate(provider('docker', ['sandbox/v1@1.1.0'])),
    // The window surfaces the stage-10 client parts of files and git require:
    // the ids they use since bundle isolation 4(a), which removed the old ones,
    // and since 4(d) the selection of `workspace` (`runtime.records/v1` is the
    // runtime's own).
    candidate(
      provider('desktop-surfaces', [
        'workspace.selection/v1@1.0.0',
        'layout.panel/v3@3.0.0',
        'layout.tabs/v2@2.0.0',
        'settings.config/v1@1.0.0',
      ]),
    ),
    candidate(provider('host-config', ['host-config/v1@1.1.0'])),
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
      platformVersion: PLATFORM_VERSION,
      generation: 1,
    },
    'host',
  );
  const state = (id: string) =>
    resolved.entries.find((entry) => entry.id === id);

  assert.deepEqual(state('runtime')?.reasons, []);
  assert.deepEqual(state('default')?.reasons, []);
  const position = (id: string) => resolved.order.indexOf(id);
  for (const before of ['core', 'docker', 'host-config'])
    assert.ok(position(before) < position('runtime'), before);
  for (const after of ['default', 'files', 'git', 'threads'])
    assert.ok(position('runtime') < position(after), after);
  // files, git and threads keep their lexical order, so tools keep theirs.
  assert.deepEqual(
    resolved.order.filter((id) => ['files', 'git', 'threads'].includes(id)),
    ['files', 'git', 'threads'],
  );
});

void test('a second provider of runtime/v2 is quarantined without a choice', async () => {
  const core = await manifestOf('core');
  const runtime = await manifestOf('runtime');
  const other = provider('runtime-copy', ['runtime/v2@2.0.0']);
  const candidates = [
    candidate(core),
    candidate(runtime),
    candidate(other),
    candidate(provider('default', ['executor/v1@1.6.0'])),
    candidate(provider('docker', ['sandbox/v1@1.1.0'])),
    candidate(provider('host-config', ['host-config/v1@1.1.0'])),
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
      .find(({ id }) => id === 'runtime/v2')
      ?.providers.map(({ bundleId }) => bundleId),
    ['runtime'],
  );
});
