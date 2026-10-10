import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { sandboxSettings } from '../src/lib/bundles/sandbox.js';
import { bundlesPath } from './helpers/platform.js';

// The kernel's `sandbox_pool` log lines describe the pool the staged
// `sandbox-adapter` builds in the generation process, so both must read the
// same environment into the same settings.

type Settings = (
  environment: Readonly<Record<string, string | undefined>>,
) => unknown;

const adapterSettings = async (): Promise<Settings> => {
  const module = (await import(
    pathToFileURL(resolve(bundlesPath, 'sandbox-adapter/host/adapter.js')).href
  )) as { sandboxSettings: Settings };
  return module.sandboxSettings;
};

const environments: readonly Readonly<Record<string, string | undefined>>[] = [
  {},
  { DORIC_SANDBOX_PROVIDER: 'docker' },
  { DORIC_SANDBOX_PROVIDER: 'firecracker' },
  { DORIC_SANDBOX_PROVIDER: 'unknown' },
  {
    DORIC_SANDBOX_PROVIDER: 'firecracker',
    DORIC_SANDBOX_IMAGE: 'doric-sandbox:local',
    DORIC_SANDBOX_SSH: 'true',
  },
  { DORIC_SANDBOX_IMAGE: 'custom:1', DORIC_SANDBOX_SSH: 'false' },
];

void test('the kernel logs the sandbox settings the staged sandbox-adapter builds its pool from', async () => {
  const adapter = await adapterSettings();
  for (const environment of environments) {
    assert.deepEqual(
      sandboxSettings(environment),
      adapter(environment),
      JSON.stringify(environment),
    );
  }
});
