import assert from 'node:assert/strict';
import test from 'node:test';
import { pino } from 'pino';

import {
  ConfigInputSchema,
  defaultConfig,
  type DoricConfig,
} from '../src/lib/config/schema.js';
import { createConfigService } from '../src/lib/config/service.js';
import type { Generation } from '../src/lib/config/generation.js';

test('accepts the complete default configuration', () => {
  assert.equal(ConfigInputSchema.safeParse(defaultConfig).success, true);
});

test('rejects credential values embedded in provider configuration', () => {
  const secret = {
    ...defaultConfig,
    providers: defaultConfig.providers.map((provider) => ({
      ...provider,
      apiKey: 'private',
    })),
  };
  assert.equal(ConfigInputSchema.safeParse(secret).success, false);
});

test('rejects credential environment names outside the API key convention', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.providers[0]!.apiKeyEnv = 'TOKEN';
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects provider URLs outside HTTP and HTTPS', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.providers[0]!.baseUrl = 'file:///tmp/provider';
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects model profiles that reference an unavailable provider', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.models.execution.providerId = 'missing';
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects fields outside the Direct configuration contract', () => {
  const invalid = { ...structuredClone(defaultConfig), routing: {} };
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects duplicate provider identifiers', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.providers.push(structuredClone(invalid.providers[0]!));
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('serializes concurrent replacements in request order', async () => {
  const harness = await configHarness({ blockedBuild: 'first' });
  const first = configured('first');
  const second = configured('second');
  const firstWrite = harness.service.replace(first);
  const secondWrite = harness.service.replace(second);
  await Promise.resolve();
  assert.deepEqual(harness.writes, []);

  harness.releaseBuild();
  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(harness.writes, ['first', 'second']);
  assert.equal(
    harness.service.current().snapshot.configuration.models.execution.model,
    'second',
  );
});

test('keeps the active generation and accepts later replacements after a build failure', async () => {
  const harness = await configHarness({ failedBuild: 'broken-build' });

  await assert.rejects(harness.service.replace(configured('broken-build')));
  assert.deepEqual(harness.writes, []);
  assert.equal(
    harness.service.current().snapshot.configuration.models.execution.model,
    defaultConfig.models.execution.model,
  );

  await harness.service.replace(configured('recovered'));
  assert.deepEqual(harness.writes, ['recovered']);
  assert.equal(
    harness.service.current().snapshot.configuration.models.execution.model,
    'recovered',
  );
});

test('keeps the active generation when persistent replacement fails', async () => {
  const harness = await configHarness({ failedWrite: 'broken-store' });
  const original = harness.service.current();

  await assert.rejects(harness.service.replace(configured('broken-store')));
  assert.deepEqual(harness.writes, []);
  assert.equal(
    harness.service.current().snapshot.configuration.models.execution.model,
    defaultConfig.models.execution.model,
  );
  const snapshot = await harness.service.replace(configured('recovered'));
  assert.equal(snapshot.configuration.models.execution.model, 'recovered');
  assert.deepEqual(harness.service.current().snapshot, snapshot);
  assert.equal(
    original.snapshot.configuration.models.execution.model,
    defaultConfig.models.execution.model,
  );
});

type ConfigHarnessOptions = {
  readonly blockedBuild?: string;
  readonly failedBuild?: string;
  readonly failedWrite?: string;
};

const configHarness = async ({
  blockedBuild,
  failedBuild,
  failedWrite,
}: ConfigHarnessOptions = {}) => {
  let revision = 1;
  const writes: string[] = [];
  let releaseBuild: () => void = () => undefined;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const store = {
    load: async () => snapshot(defaultConfig, revision),
    replace: async (configuration: typeof defaultConfig) => {
      const model = configuration.models.execution.model;
      if (model === failedWrite) throw new Error('store unavailable');
      writes.push(model);
      return snapshot(configuration, ++revision);
    },
  };
  const build = async ({ snapshot: current }: { snapshot: DoricConfig }) => {
    const model = current.configuration.models.execution.model;
    if (model === blockedBuild) await buildGate;
    if (model === failedBuild) throw new Error('generation unavailable');
    return {
      snapshot: current,
      providers: new Map(),
      redactions: () => [],
      catalog: { skills: [], tools: [] },
    } satisfies Generation;
  };
  const service = await createConfigService({
    store,
    bundles: [],
    logger: pino({ enabled: false }),
    buildGeneration: build,
  });
  return { service, writes, releaseBuild };
};

const configured = (model: string) => {
  const config = structuredClone(defaultConfig);
  config.models.execution.model = model;
  return config;
};

const snapshot = (
  configuration: typeof defaultConfig,
  revision: number,
): DoricConfig => ({
  configuration,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});
