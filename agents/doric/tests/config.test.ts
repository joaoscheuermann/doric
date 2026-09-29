import assert from 'node:assert/strict';
import test from 'node:test';
import { pino } from 'pino';

import {
  createGeneration,
  type Generation,
} from '../src/lib/config/generation.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  defaultConfig,
  type DoricConfig,
} from '../src/lib/config/schema.js';
import {
  ConfigCredentialError,
  createConfigService,
} from '../src/lib/config/service.js';
import type { Credential } from '../src/lib/credentials/kind.js';
import { eventJson } from '../src/lib/events/serialization.js';
import { credentialResolver } from './helpers/workspace.js';

/** The credential the seeded baseline provider authenticates with. */
const providerCredential: Credential = {
  id: defaultConfig.providers[0].credentialId,
  kind: 'API_TOKEN',
  name: 'OPENROUTER_API_KEY',
  secret: 'sk_stored',
};

const gitCredential: Credential = {
  id: '00000000-0000-4000-8000-00000000000a',
  kind: 'GIT',
  name: 'github',
  username: 'octocat',
  email: 'octocat@example.com',
};

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

test('rejects a provider credential reference that is not a UUID', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.providers[0].credentialId = 'OPENROUTER_API_KEY';
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

test('rejects a provider that references a credential of the wrong kind', async () => {
  const harness = await configHarness({
    credentials: [providerCredential, gitCredential],
  });
  const invalid = structuredClone(defaultConfig);
  invalid.providers[0].credentialId = gitCredential.id;

  await assert.rejects(harness.service.replace(invalid), ConfigCredentialError);
  assert.deepEqual(harness.writes, []);
});

test('rejects a configuration that references an unstored credential', async () => {
  const harness = await configHarness({ credentials: [providerCredential] });
  const invalid = structuredClone(defaultConfig);
  invalid.gitCredentialId = gitCredential.id;

  await assert.rejects(harness.service.replace(invalid), ConfigCredentialError);
  assert.deepEqual(harness.writes, []);
});

test('accepts a Git identity and a GitHub token of the right kinds', async () => {
  const harness = await configHarness({
    credentials: [providerCredential, gitCredential],
  });
  const github: Credential = {
    id: '00000000-0000-4000-8000-00000000000b',
    kind: 'API_TOKEN',
    name: 'github',
    secret: 'ghp_stored',
  };
  harness.store([providerCredential, gitCredential, github]);

  const snapshot = await harness.service.replace({
    ...structuredClone(defaultConfig),
    gitCredentialId: gitCredential.id,
    githubCredentialId: github.id,
  });

  assert.deepEqual(snapshot.configuration.gitCredentialId, gitCredential.id);
  assert.deepEqual(snapshot.configuration.githubCredentialId, github.id);
  assert.deepEqual(harness.writes, [defaultConfig.models.execution.model]);
});

test('redacts every stored secret from event values', async () => {
  const generation = await createGeneration({
    snapshot: snapshot(defaultConfig, 1),
    credentials: credentialResolver(() => [providerCredential]),
    bundles: [],
    logger: pino({ enabled: false }),
  });
  const unconfigured = await createGeneration({
    snapshot: snapshot(defaultConfig, 1),
    credentials: credentialResolver(),
    bundles: [],
    logger: pino({ enabled: false }),
  });

  assert.equal(
    generation.redactions().includes(providerCredential.secret!),
    true,
  );
  assert.equal(
    unconfigured.redactions().includes(providerCredential.secret!),
    false,
  );
  assert.deepEqual(
    eventJson({ output: providerCredential.secret }, generation.redactions()),
    { output: '[REDACTED]' },
  );
});

test('redacts a rotated secret a running Project learned after it was built', async () => {
  const rotated = 'ghp_rotated_later';
  const generation = await createGeneration({
    snapshot: snapshot(defaultConfig, 1),
    credentials: credentialResolver(),
    bundles: [],
    logger: pino({ enabled: false }),
  });

  assert.equal(generation.redactions().includes(rotated), false);

  generation.registerSecret(rotated);

  assert.equal(generation.redactions().includes(rotated), true);
  assert.deepEqual(eventJson({ output: rotated }, generation.redactions()), {
    output: '[REDACTED]',
  });

  generation.registerSecret('');

  assert.equal(generation.redactions().includes(''), false);
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
  readonly credentials?: readonly Credential[];
  readonly blockedBuild?: string;
  readonly failedBuild?: string;
  readonly failedWrite?: string;
};

const configHarness = async ({
  credentials = [providerCredential],
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
  let stored = credentials;
  const store = {
    load: async () => snapshot(defaultConfig, revision),
    replace: async (configuration: ConfigInput) => {
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
      registerSecret: () => undefined,
      catalog: { skills: [], tools: [] },
    } satisfies Generation;
  };
  const service = await createConfigService({
    store,
    credentials: credentialResolver(() => stored),
    bundles: [],
    logger: pino({ enabled: false }),
    buildGeneration: build,
  });
  return {
    service,
    writes,
    releaseBuild,
    store: (next: readonly Credential[]) => {
      stored = next;
    },
  };
};

const configured = (model: string) => {
  const config = structuredClone(defaultConfig);
  config.models.execution.model = model;
  return config;
};

const snapshot = (
  configuration: ConfigInput,
  revision: number,
): DoricConfig => ({
  configuration,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});
