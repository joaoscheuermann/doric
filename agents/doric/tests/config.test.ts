import assert from 'node:assert/strict';
import test from 'node:test';

import { pino } from 'pino';

import { type ProviderKind, providerKinds } from 'llms';

import {
  createGeneration,
  type Generation,
  providerFor,
} from '../src/lib/config/generation.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  defaultConfig,
  type DoricConfig,
  providerCredentials,
} from '../src/lib/config/schema.js';
import {
  ConfigCredentialError,
  createConfigService,
} from '../src/lib/config/service.js';
import type { Credential } from '../src/lib/credentials/kind.js';
import type { CredentialService } from '../src/lib/credentials/service.js';
import { eventJson } from '../src/lib/events/serialization.js';
import { credentialResolver } from './helpers/workspace.js';

/** The credential the seeded baseline provider authenticates with. */
const providerCredential: Credential = {
  id: defaultConfig.providers[0].configuration.token,
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

/** The provider's own values, so a case can break exactly one of them. */
const providerOf = () => structuredClone(defaultConfig.providers[0]);

/**
 * A configuration whose one provider is the value under test, executed by it, so
 * every case is about that provider alone. Values are typed loosely because most
 * cases are shapes the schema is meant to refuse.
 */
const withProvider = (
  provider: { readonly id: string } & Readonly<Record<string, unknown>>,
): unknown => ({
  ...structuredClone(defaultConfig),
  providers: [provider],
  models: {
    execution: {
      ...defaultConfig.models.execution,
      providerId: provider.id,
    },
  },
});

test('accepts the complete default configuration', () => {
  assert.equal(ConfigInputSchema.safeParse(defaultConfig).success, true);
});

test('carries each provider kind with the values that kind declares', () => {
  // Every kind the catalog declares is a kind a stored configuration can name.
  assert.deepEqual(
    providerKinds.map(({ id }) => id).sort(),
    [...new Set(providerKinds.map(({ id }) => id))].sort(),
  );

  for (const kind of providerKinds) {
    const provider = {
      id: 'provider',
      kind: kind.id,
      configuration: Object.fromEntries(
        kind.fields
          .filter((field) => field.required)
          .map((field) => [field.key, valueFor(field)]),
      ),
      ...(kind.lists.includes('models')
        ? {
            models: [
              {
                name: 'a-model',
                ...(kind.lists.includes('reasonings')
                  ? { reasonings: ['low'] }
                  : {}),
              },
            ],
          }
        : {}),
    };

    assert.equal(
      ConfigInputSchema.safeParse(withProvider(provider)).success,
      true,
      `kind ${kind.id} was rejected with its own values`,
    );
  }
});

/** A value a field's own kind accepts, which is what the schema judges. */
const valueFor = (field: ProviderKind['fields'][number]): string => {
  switch (field.kind) {
    case 'url':
      return 'https://example.test/v1';
    case 'number':
      return '1';
    case 'enum':
      return field.options?.[0] ?? '';
    case 'secret':
      return providerCredential.id;
    case 'text':
      return `${field.key} value`;
  }
};

test('rejects a provider kind the catalog does not know', () => {
  const invalid = withProvider({ ...providerOf(), kind: 'anthropic' });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects a value the kind does not declare, including a credential of its own', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: { ...providerOf().configuration, apiKey: 'private' },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects a provider that omits a value its kind requires', () => {
  // OpenRouter authenticates with a stored token, and a provider without one
  // cannot be built.
  const invalid = withProvider({
    id: 'openrouter',
    kind: 'openrouter',
    configuration: { endpoint: 'https://openrouter.ai/api/v1' },
    models: [{ name: 'a-model', reasonings: ['low'] }],
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects an optional value that is set to nothing', () => {
  // Absence is how an optional field is unset; an empty string is a value the
  // provider cannot use and the settings surface must not send.
  const invalid = withProvider({
    id: 'local',
    kind: 'lmstudio',
    configuration: { endpoint: '', token: '' },
    models: [],
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects a provider credential reference that is not a UUID', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      token: 'OPENROUTER_API_KEY',
    },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects provider URLs outside HTTP and HTTPS', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      endpoint: 'file:///tmp/provider',
    },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('rejects a number value that is not a number and an enum value outside its options', () => {
  const unified = {
    id: 'unified',
    kind: 'unified',
    configuration: {
      endpoint: 'https://openrouter.ai/api/v1',
      token: providerCredential.id,
      maxStructuredOutputRepairs: 'two',
    },
    models: [{ name: 'a-model', reasonings: ['low'] }],
  };
  const codex = {
    id: 'codex',
    kind: 'codex',
    configuration: { token: providerCredential.id, fedramp: 'sometimes' },
  };

  assert.equal(
    ConfigInputSchema.safeParse(withProvider(unified)).success,
    false,
  );
  assert.equal(ConfigInputSchema.safeParse(withProvider(codex)).success, false);

  // The same two kinds accept the values their own kinds declare.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...unified,
        configuration: {
          ...unified.configuration,
          maxStructuredOutputRepairs: '0',
        },
      }),
    ).success,
    true,
  );
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...codex,
        configuration: { ...codex.configuration, fedramp: 'true' },
      }),
    ).success,
    true,
  );
});

test('rejects a list the kind does not keep, and a kind that omits one it does', () => {
  // Codex keeps no model list, and the OpenAI-compatible kind keeps one.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        id: 'codex',
        kind: 'codex',
        configuration: { token: providerCredential.id },
        models: [{ name: 'gpt-codex' }],
      }),
    ).success,
    false,
  );

  // A kind that keeps a model list must carry it, even when the provider names
  // no model yet.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        id: 'openrouter',
        kind: 'openai-compatible',
        configuration: {},
      }),
    ).success,
    false,
  );

  // LM Studio keeps models but not reasoning efforts, so a model of its carries
  // a name alone.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        id: 'local',
        kind: 'lmstudio',
        configuration: {},
        models: [{ name: 'local-model', reasonings: ['low'] }],
      }),
    ).success,
    false,
  );
});

test('accepts a model list a kind keeps while it holds nothing yet', () => {
  // A migrated provider has no models of its own until an operator names them,
  // and the execution section is what falls back to a typed model.
  const [provider] = defaultConfig.providers;
  assert.deepEqual(provider?.models, []);
  assert.equal(ConfigInputSchema.safeParse(defaultConfig).success, true);
});

test('rejects a model list entry that repeats, is empty, or carries a bad effort', () => {
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...providerOf(),
        models: [{ name: 'a-model' }, { name: 'a-model' }],
      }),
    ).success,
    false,
  );
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({ ...providerOf(), models: [{ name: ' ' }] }),
    ).success,
    false,
  );
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...providerOf(),
        models: [{ name: 'a-model', reasonings: ['low', 'low'] }],
      }),
    ).success,
    false,
  );
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...providerOf(),
        models: [{ name: 'a-model', reasonings: ['extreme'] }],
      }),
    ).success,
    false,
  );
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
  invalid.providers.push(structuredClone(invalid.providers[0]));
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

test('names the credential each provider secret field carries', () => {
  const [provider] = defaultConfig.providers;
  assert.ok(provider !== undefined);

  assert.deepEqual(
    providerCredentials(provider).map(({ field, id }) => ({
      key: field.key,
      id,
    })),
    [{ key: 'token', id: providerCredential.id }],
  );
  assert.deepEqual(
    providerCredentials({
      id: 'local',
      kind: 'lmstudio',
      configuration: {},
      models: [{ name: 'local-model' }],
    }),
    [],
  );
});

test('rejects a provider that references a credential of the wrong kind', async () => {
  const harness = await configHarness({
    credentials: [providerCredential, gitCredential],
  });
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      token: gitCredential.id,
    },
  }) as ConfigInput;

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

test('builds every configured provider through the kind it names', async () => {
  const configuration: ConfigInput = {
    ...structuredClone(defaultConfig),
    providers: [
      {
        id: 'local',
        kind: 'lmstudio',
        configuration: {},
        models: [{ name: 'local-model' }],
      },
      {
        id: 'proxy',
        kind: 'openai-compatible',
        configuration: {},
        models: [{ name: 'proxy-model', reasonings: ['low'] }],
      },
    ],
    models: {
      execution: {
        providerId: 'local',
        model: 'local-model',
        effort: 'low',
      },
    },
  };
  const generation = await createGeneration({
    snapshot: snapshot(configuration, 1),
    credentials: credentialResolver(() => [providerCredential]),
    bundles: [],
    logger: pino({ enabled: false }),
  });

  // The factory each provider names is what answers, not one hard-coded kind.
  assert.equal(providerFor(generation, 'local').metadata.id, 'lmstudio');
  assert.equal(providerFor(generation, 'proxy').metadata.id, 'proxy');
  assert.throws(() => providerFor(generation, 'missing'));
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

test('redacts a secret the credentials learned after the generation was built', async () => {
  const rotated = 'ghp_rotated_later';
  const credentials: CredentialService = credentialResolver();
  const generation = await createGeneration({
    snapshot: snapshot(defaultConfig, 1),
    credentials,
    bundles: [],
    logger: pino({ enabled: false }),
  });

  assert.equal(generation.redactions().includes(rotated), false);

  credentials.register(rotated);

  assert.equal(generation.redactions().includes(rotated), true);
  assert.deepEqual(eventJson({ output: rotated }, generation.redactions()), {
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

interface ConfigHarnessOptions {
  readonly credentials?: readonly Credential[];
  readonly blockedBuild?: string;
  readonly failedBuild?: string;
  readonly failedWrite?: string;
}

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
      catalog: { skills: [], tools: [] },
    } satisfies Generation;
  };
  const service = await createConfigService({
    store,
    credentials: credentialResolver(() => stored),
    bundles: [],
    logger: pino({ enabled: false }),
    buildGeneration: build,
    // The catalog reader has its own cases; this harness is about the store and
    // the service, so it must never reach an endpoint.
    readModels: (configuration) => Promise.resolve(configuration),
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
