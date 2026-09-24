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
  type ConfigUpdate,
  defaultConfig,
  type DoricConfig,
  publicConfig,
} from '../src/lib/config/schema.js';
import {
  type ConfigService,
  createConfigService,
} from '../src/lib/config/service.js';
import { eventJson } from '../src/lib/events/serialization.js';

const identity = { username: 'octocat', email: 'octocat@example.com' };

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

test('accepts a GitHub identity with and without a token', () => {
  const cases = [{ ...identity }, { ...identity, token: 'ghp_stored' }];

  cases.forEach((github) => {
    assert.equal(
      ConfigInputSchema.safeParse({ ...defaultConfig, github }).success,
      true,
    );
  });
});

test('rejects an invalid GitHub username, email, or token', () => {
  const cases = [
    { username: '', email: identity.email },
    { username: 'a'.repeat(129), email: identity.email },
    { username: identity.username, email: 'not-an-address' },
    { username: identity.username, email: identity.email, token: '' },
    {
      username: identity.username,
      email: identity.email,
      token: 'line\nbreak',
    },
    {
      username: identity.username,
      email: identity.email,
      token: 'x'.repeat(513),
    },
  ];

  cases.forEach((github) => {
    assert.equal(
      ConfigInputSchema.safeParse({ ...defaultConfig, github }).success,
      false,
    );
  });
});

test('rejects a GitHub block without both public identity fields', () => {
  assert.equal(
    ConfigInputSchema.safeParse({
      ...defaultConfig,
      github: { email: identity.email, token: 'ghp_stored' },
    }).success,
    false,
  );
});

test('answers the public view of a configured snapshot without its token', () => {
  const token = 'ghp_stored';
  const view = publicConfig(snapshot(withGithub({ ...identity, token }), 3));

  assert.deepEqual(view.configuration.github, { ...identity, hasToken: true });
  assert.equal(JSON.stringify(view).includes(token), false);
});

test('reports a public-only GitHub identity without a token', () => {
  const view = publicConfig(snapshot(withGithub({ ...identity }), 3));

  assert.deepEqual(view.configuration.github, { ...identity, hasToken: false });
});

test('omits the GitHub block from the public view when it was never configured', () => {
  const view = publicConfig(snapshot(defaultConfig, 1));

  assert.equal('github' in view.configuration, false);
});

test('keeps the stored GitHub token when a replacement omits or nulls it', async () => {
  const harness = await configHarness({
    initial: withGithub({ ...identity, token: 'ghp_stored' }),
  });

  await harness.service.replace(update({ ...identity }));
  assert.deepEqual(storedGithub(harness.service), {
    ...identity,
    token: 'ghp_stored',
  });

  await harness.service.replace(update({ ...identity, token: null }));
  assert.deepEqual(storedGithub(harness.service), {
    ...identity,
    token: 'ghp_stored',
  });
});

test('keeps the stored GitHub identity when a replacement omits the block', async () => {
  const harness = await configHarness({
    initial: withGithub({ ...identity, token: 'ghp_stored' }),
  });

  await harness.service.replace(update());
  assert.deepEqual(storedGithub(harness.service), {
    ...identity,
    token: 'ghp_stored',
  });
});

test('removes the stored GitHub block when a replacement nulls it', async () => {
  const harness = await configHarness({
    initial: withGithub({ ...identity, token: 'ghp_stored' }),
  });

  await harness.service.replace(update(null));
  assert.equal(storedGithub(harness.service), undefined);
});

test('replaces a stored GitHub token and clears it on an empty string', async () => {
  const harness = await configHarness({
    initial: withGithub({ ...identity, token: 'ghp_stored' }),
  });

  await harness.service.replace(
    update({ ...identity, token: 'ghp_replacement' }),
  );
  assert.deepEqual(storedGithub(harness.service), {
    ...identity,
    token: 'ghp_replacement',
  });

  await harness.service.replace(update({ ...identity, token: '' }));
  assert.deepEqual(storedGithub(harness.service), { ...identity });
});

test('redacts the configured GitHub token from event values', async () => {
  const token = 'ghp_stored';
  const generation = await createGeneration({
    snapshot: snapshot(withGithub({ ...identity, token }), 1),
    bundles: [],
    logger: pino({ enabled: false }),
    environment: {},
  });
  const unconfigured = await createGeneration({
    snapshot: snapshot(defaultConfig, 1),
    bundles: [],
    logger: pino({ enabled: false }),
    environment: {},
  });

  assert.equal(generation.redactions().includes(token), true);
  assert.equal(unconfigured.redactions().includes(token), false);
  assert.deepEqual(eventJson({ output: token }, generation.redactions()), {
    output: '[REDACTED]',
  });
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
  readonly initial?: ConfigInput;
  readonly blockedBuild?: string;
  readonly failedBuild?: string;
  readonly failedWrite?: string;
};

const configHarness = async ({
  initial = defaultConfig,
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
    load: async () => snapshot(initial, revision),
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

const withGithub = (
  github: NonNullable<ConfigInput['github']>,
): ConfigInput => ({
  ...structuredClone(defaultConfig),
  github,
});

const update = (github?: ConfigUpdate['github']): ConfigUpdate => ({
  ...configured('replacement'),
  ...(github === undefined ? {} : { github }),
});

/** The GitHub block the service most recently persisted. */
const storedGithub = (service: ConfigService) =>
  service.current().snapshot.configuration.github;

const snapshot = (
  configuration: ConfigInput,
  revision: number,
): DoricConfig => ({
  configuration,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});
