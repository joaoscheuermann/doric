import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  sandboxComposition,
  sandboxSettings,
} from '../src/lib/bundles/sandbox.js';
import { bundlesPath } from './helpers/platform.js';

// The kernel's `sandbox_pool` log lines describe the pool the staged
// `docker` or `firecracker` bundle builds in the generation process, so both
// must read the same environment into the same settings; and the shipped
// composition enables the bundle `DORIC_SANDBOX_PROVIDER` names (D10-9).

type Settings = (
  environment: Readonly<Record<string, string | undefined>>,
) => unknown;

const bundleSettings = async (
  bundle: 'docker' | 'firecracker',
): Promise<Settings> => {
  const module = (await import(
    pathToFileURL(resolve(bundlesPath, `${bundle}/host/sandbox.js`)).href
  )) as Record<string, Settings>;
  const settings = module[`${bundle}SandboxSettings`];
  assert.ok(settings);
  return settings;
};

const environments: readonly Readonly<Record<string, string | undefined>>[] = [
  {},
  { DORIC_SANDBOX_IMAGE: 'doric-sandbox:local', DORIC_SANDBOX_SSH: 'true' },
  { DORIC_SANDBOX_IMAGE: 'custom:1', DORIC_SANDBOX_SSH: 'false' },
];

void test('the kernel logs the sandbox settings the staged sandbox bundle builds its pool from', async () => {
  for (const bundle of ['docker', 'firecracker'] as const) {
    const settings = await bundleSettings(bundle);
    for (const environment of environments) {
      const { providerName, ...logged } = sandboxSettings(environment, bundle);
      assert.equal(providerName, bundle);
      assert.deepEqual(
        logged,
        settings(environment),
        JSON.stringify(environment),
      );
    }
  }
});

const shipped = 'agents/doric/composition.json';

const enabledOf = (composition: unknown): readonly string[] =>
  (composition as { enabled: readonly string[] }).enabled;

void test('the shipped composition boots docker unless DORIC_SANDBOX_PROVIDER asks for firecracker', async () => {
  for (const environment of [
    {},
    { DORIC_SANDBOX_PROVIDER: 'docker' },
    { DORIC_SANDBOX_PROVIDER: 'unknown' },
  ]) {
    const chosen = await sandboxComposition(environment, shipped);
    assert.equal(chosen.providerName, 'docker');
    assert.deepEqual(chosen.composition, { path: shipped });
  }

  const firecracker = await sandboxComposition(
    { DORIC_SANDBOX_PROVIDER: 'firecracker' },
    shipped,
  );
  assert.equal(firecracker.providerName, 'firecracker');
  const enabled = enabledOf(firecracker.composition);
  assert.ok(enabled.includes('firecracker'));
  assert.ok(!enabled.includes('docker'));
  // Every other bundle stays enabled, in place.
  const docker = enabledOf(JSON.parse(await readFile(shipped, 'utf8')));
  assert.deepEqual(
    enabled,
    docker.map((id) => (id === 'docker' ? 'firecracker' : id)),
  );
});

void test('an operator composition names its sandbox bundle itself', async () => {
  const directory = await mkdtemp(join('agents/doric/dist-tests', 'sandbox-'));
  const path = join(directory, 'composition.json');
  try {
    await writeFile(
      path,
      JSON.stringify({ core: 'core', enabled: ['core', 'firecracker'] }),
    );
    const own = await sandboxComposition(
      { DORIC_COMPOSITION: path, DORIC_SANDBOX_PROVIDER: 'docker' },
      path,
    );
    assert.equal(own.providerName, 'firecracker');
    assert.deepEqual(own.composition, { path });

    await writeFile(
      path,
      JSON.stringify({ core: 'core', enabled: ['core', 'docker'] }),
    );
    const kept = await sandboxComposition(
      { DORIC_COMPOSITION: path, DORIC_SANDBOX_PROVIDER: 'firecracker' },
      path,
    );
    assert.equal(kept.providerName, 'docker');
    assert.deepEqual(kept.composition, { path });

    // An unreadable file is left to the kernel's own refusal.
    await writeFile(path, '{');
    assert.deepEqual(
      await sandboxComposition({ DORIC_COMPOSITION: path }, path),
      { composition: { path }, providerName: 'docker' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
