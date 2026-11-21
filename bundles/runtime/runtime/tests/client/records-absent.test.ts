// With the runtime's client part failing to activate, a bundle that requires
// `runtime.records/v1` is quarantined with it and one that lists it under
// `optional` activates (bundle isolation phase 3, T3.3). The runtime takes
// part with its real manifest; its client part is a stand-in that throws.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Activate } from 'bundle/contracts';
import {
  activateEnvironment,
  type CatalogCandidate,
  catalogSnapshot,
  catalogView,
  createPrincipal,
  type Descriptor,
  DiagnosticsStore,
  type ManifestV1,
  manifestV1Schema,
  PLATFORM_VERSION,
  providePlatformServices,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from 'bundle/runtime';

const records = 'runtime.records/v1';

interface TestBundle {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly activate?: Activate;
}

const idOf = (entry: string) => entry.slice(0, entry.indexOf('@'));
const versionOf = (entry: string) => entry.slice(entry.indexOf('@') + 1);

const descriptorOf = (
  manifest: ManifestV1,
  environmentOf: (id: string) => 'host' | 'client',
): Descriptor => ({
  descriptorVersion: 1,
  bundle: { id: manifest.id, version: manifest.version },
  contracts: manifest.provides.map((entry) => ({
    id: idOf(entry),
    version: versionOf(entry),
    kind: 'service',
    environment: environmentOf(idOf(entry)),
    cardinality: 'one',
    local: environmentOf(idOf(entry)) === 'client',
    schema: `schemas/${idOf(entry)}.json`,
  })),
});

/** The lowest version a `requires` range of the runtime accepts. */
const lowest = (entry: string) => versionOf(entry).replace(/^\^/, '');

/**
 * A stand-in core: it provides on the host every contract the runtime
 * requires, so the runtime's requires hold, and draws nothing in a window.
 */
const coreFor = (runtime: ManifestV1): TestBundle => {
  const manifest = manifestV1Schema.parse({
    manifestVersion: 1,
    id: 'core',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: runtime.requires.map(
      (entry) => `${idOf(entry)}@${lowest(entry)}`,
    ),
    requires: [],
  });
  return { manifest, descriptor: descriptorOf(manifest, () => 'host') };
};

/** A window bundle that provides `<id>.api/v1` and lists the mirror as `list`. */
const consumer = (
  id: string,
  list: 'requires' | 'optional',
  activated: string[],
): TestBundle => {
  const manifest = manifestV1Schema.parse({
    manifestVersion: 1,
    id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [`${id}.api/v1@1.0.0`],
    requires: list === 'requires' ? [`${records}@^1.0.0`] : [],
    ...(list === 'optional' ? { optional: [records] } : {}),
  });
  return {
    manifest,
    descriptor: descriptorOf(manifest, () => 'client'),
    activate: () => {
      activated.push(id);
    },
  };
};

const windowWith = async () => {
  const runtimeManifest = manifestV1Schema.parse(
    JSON.parse(await readFile('bundles/runtime/runtime/manifest.json', 'utf8')),
  );
  const activated: string[] = [];
  const runtime: TestBundle = {
    manifest: runtimeManifest,
    descriptor: descriptorOf(runtimeManifest, (id) =>
      id === records ? 'client' : 'host',
    ),
    activate: () => {
      throw new Error('the client part failed to activate');
    },
  };
  const all = [
    coreFor(runtimeManifest),
    runtime,
    consumer('needs', 'requires', activated),
    consumer('wants', 'optional', activated),
  ];
  const candidates: CatalogCandidate[] = all.map((bundle) => ({
    id: bundle.manifest.id,
    source: { kind: 'embedded' },
    manifest: bundle.manifest,
    descriptor: bundle.descriptor,
    errors: [],
  }));
  const resolved = resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: all.map(({ manifest }) => manifest.id),
        providers: {},
      },
      platformVersion: PLATFORM_VERSION,
      generation: 1,
    },
    'client',
  );
  const diagnostics = new DiagnosticsStore({ generation: 1 });
  diagnostics.load(resolved);
  const runtimeServices: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: catalogView(resolved),
    environment: 'client',
    generation: 1,
    generationSignal: new AbortController().signal,
    report: (entry) => diagnostics.report(entry),
  };
  const platform = createPrincipal(runtimeServices, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });
  providePlatformServices(platform, {
    snapshot: () => catalogSnapshot(resolved, diagnostics),
    diagnostics,
    sink: { write: () => undefined },
  });
  const byId = new Map(all.map((bundle) => [bundle.manifest.id, bundle]));
  const result = await activateEnvironment({
    resolved,
    runtime: runtimeServices,
    platform,
    diagnostics,
    loadPart: async (entry) => byId.get(entry.id)?.activate,
  });
  return {
    activated,
    result,
    state: (id: string) => diagnostics.state(id),
    reasons: (id: string) => diagnostics.reasons(id),
  };
};

void test('a bundle that requires runtime.records/v1 is quarantined with the failed client part', async () => {
  const window = await windowWith();

  assert.equal(window.state('runtime'), 'quarantined');
  assert.deepEqual(
    window.reasons('runtime').map(({ code }) => code),
    ['activate_failed'],
  );
  assert.equal(window.state('needs'), 'quarantined');
  assert.deepEqual(
    window.reasons('needs').map(({ code }) => code),
    ['dependency_quarantined'],
  );
  assert.ok(!window.activated.includes('needs'));
  assert.ok(!window.result.active.includes('needs'));
});

void test('a bundle that lists runtime.records/v1 under optional activates', async () => {
  const window = await windowWith();

  assert.ok(window.activated.includes('wants'));
  assert.ok(window.result.active.includes('wants'));
  assert.notEqual(window.state('wants'), 'quarantined');
});
