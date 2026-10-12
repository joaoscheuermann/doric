import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { CatalogSnapshot } from 'bundle/contracts';

import {
  defaultRequirement,
  hostComposition,
  structuralFault,
} from '../src/lib/bundles/boot.js';

// The shipped composition enables the sandbox bundle `DORIC_SANDBOX_PROVIDER`
// names (D10-9). The kernel keeps no sandbox settings: each sandbox bundle reads
// its own environment in its generation process.

const shipped = 'agents/doric/composition.json';

const enabledOf = (composition: unknown): readonly string[] =>
  (composition as { enabled: readonly string[] }).enabled;

void test('the shipped composition boots docker unless DORIC_SANDBOX_PROVIDER asks for firecracker', async () => {
  for (const environment of [
    {},
    { DORIC_SANDBOX_PROVIDER: 'docker' },
    { DORIC_SANDBOX_PROVIDER: 'unknown' },
  ]) {
    const chosen = await hostComposition(environment, shipped);
    assert.deepEqual(chosen.alternatives, { sandbox: 'docker' });
    assert.deepEqual(chosen.composition, { path: shipped });
  }

  const firecracker = await hostComposition(
    { DORIC_SANDBOX_PROVIDER: 'firecracker' },
    shipped,
  );
  assert.deepEqual(firecracker.alternatives, { sandbox: 'firecracker' });
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

void test('the shipped composition requires what the host always required', async () => {
  const chosen = await hostComposition({}, shipped);

  assert.deepEqual(chosen.required, defaultRequirement);
});

const withComposition = async (
  document: unknown,
  run: (path: string) => Promise<void>,
) => {
  const directory = await mkdtemp(join('agents/doric/dist-tests', 'sandbox-'));
  const path = join(directory, 'composition.json');
  try {
    // A string is written as it is: the unreadable case is not JSON.
    await writeFile(
      path,
      typeof document === 'string' ? document : JSON.stringify(document),
    );
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const alternatives = {
  sandbox: {
    env: 'DORIC_SANDBOX_PROVIDER',
    default: 'docker',
    options: ['docker', 'firecracker'],
  },
};

void test('an operator composition names its sandbox bundle itself', async () => {
  await withComposition(
    { core: 'core', enabled: ['core', 'firecracker'], alternatives },
    async (path) => {
      const own = await hostComposition(
        { DORIC_COMPOSITION: path, DORIC_SANDBOX_PROVIDER: 'docker' },
        path,
      );
      assert.deepEqual(own.alternatives, { sandbox: 'firecracker' });
      assert.deepEqual(own.composition, { path });
    },
  );

  await withComposition(
    { core: 'core', enabled: ['core', 'docker'], alternatives },
    async (path) => {
      const kept = await hostComposition(
        { DORIC_COMPOSITION: path, DORIC_SANDBOX_PROVIDER: 'firecracker' },
        path,
      );
      assert.deepEqual(kept.alternatives, { sandbox: 'docker' });
      assert.deepEqual(kept.composition, { path });
    },
  );
});

void test('an operator composition without alternatives boots as written', async () => {
  await withComposition(
    { core: 'core', enabled: ['core', 'firecracker'] },
    async (path) => {
      const own = await hostComposition(
        { DORIC_COMPOSITION: path, DORIC_SANDBOX_PROVIDER: 'docker' },
        path,
      );
      // No alternative is declared, so none is named: the enabled bundles
      // boot as written and no sandbox option is assumed.
      assert.deepEqual(own.alternatives, {});
      assert.deepEqual(own.composition, { path });
    },
  );
});

void test('an operator composition without required keeps the structural requirement', async () => {
  await withComposition({ core: 'core', enabled: ['core'] }, async (path) => {
    const own = await hostComposition({ DORIC_COMPOSITION: path }, path);

    assert.deepEqual(own.required, defaultRequirement);
    assert.deepEqual(own.required.bundles, ['transport']);
  });
});

void test('an operator composition without required refuses a host without transport, as HEAD did', async () => {
  await withComposition({ core: 'core', enabled: ['core'] }, async (path) => {
    const own = await hostComposition({ DORIC_COMPOSITION: path }, path);
    // Only the core is active: the structural set is missing, as the host's
    // boot reported it before `required` was configurable.
    const catalog = {
      contracts: [],
      bundles: [{ id: 'core', state: 'active' }],
    } as unknown as CatalogSnapshot;

    assert.equal(
      structuralFault(catalog, own.required),
      'structural providers unavailable: runtime/v1, executor/v1, sandbox/v1, models/v1, host-config/v1, transport',
    );
  });
});

void test('an unreadable composition is left to the kernel with the same requirement', async () => {
  await withComposition('{', async (path) => {
    assert.deepEqual(await hostComposition({ DORIC_COMPOSITION: path }, path), {
      composition: { path },
      alternatives: {},
      required: defaultRequirement,
    });
  });
});
