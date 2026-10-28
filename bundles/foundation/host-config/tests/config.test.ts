import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CatalogResult,
  defineSettings,
  type ModelKindDescriptor,
  type Settings,
  type SettingsDefinition,
  type SettingsEntry,
} from 'bundle/contracts';
import { type ProviderKind, providerKinds } from 'llms';
import type { BoundTool } from 'tool';

import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
  defaultConfig,
  providerCredentials,
} from '../src/host/config/schema.js';
import { createConfigService } from '../src/host/config/service.js';
import { createConfigStore } from '../src/host/config/store.js';
import {
  type ConfigurationSettings,
  configurationSettingsId,
} from '../src/host/configuration.js';
import type { Credential } from '../src/host/credentials/kind.js';
import { credentialResolver } from './helpers/credentials.js';

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

/**
 * An execution whose context-compaction policy is the value under test, loosely
 * typed because most cases are shapes the schema is meant to refuse.
 */
const withCompaction = (
  contextCompaction: Record<string, unknown>,
): unknown => ({
  ...structuredClone(defaultConfig),
  execution: { ...defaultConfig.execution, contextCompaction },
});

void test('accepts the complete default configuration', () => {
  assert.equal(ConfigInputSchema.safeParse(defaultConfig).success, true);
});

void test('carries each provider kind with the values that kind declares', () => {
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

void test('rejects a provider kind the catalog does not know', () => {
  const invalid = withProvider({ ...providerOf(), kind: 'anthropic' });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects a value the kind does not declare, including a credential of its own', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: { ...providerOf().configuration, apiKey: 'private' },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects a provider that omits a value its kind requires', () => {
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

void test('rejects an optional value that is set to nothing', () => {
  // Absence is how an optional field is unset; an empty string is a value the
  // provider cannot use and the settings surface must not send.
  const invalid = withProvider({
    id: 'local',
    kind: 'openai',
    configuration: { endpoint: '', token: '' },
    models: [],
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects a provider credential reference that is not a UUID', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      token: 'OPENROUTER_API_KEY',
    },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects provider URLs outside HTTP and HTTPS', () => {
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      endpoint: 'file:///tmp/provider',
    },
  });

  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects a number value that is not a number and an enum value outside its options', () => {
  const router = {
    id: 'router',
    kind: 'openrouter',
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
    ConfigInputSchema.safeParse(withProvider(router)).success,
    false,
  );
  assert.equal(ConfigInputSchema.safeParse(withProvider(codex)).success, false);

  // The same two kinds accept the values their own kinds declare.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        ...router,
        configuration: {
          ...router.configuration,
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

void test('rejects a list the kind does not keep, and a kind that omits one it does', () => {
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
        kind: 'openai',
        configuration: {},
      }),
    ).success,
    false,
  );

  // OpenAI models must carry their reasoning list, even when it is empty.
  assert.equal(
    ConfigInputSchema.safeParse(
      withProvider({
        id: 'local',
        kind: 'openai',
        configuration: {},
        models: [{ name: 'local-model' }],
      }),
    ).success,
    false,
  );
});

void test('accepts a model list a kind keeps while it holds nothing yet', () => {
  // A migrated provider has no models of its own until an operator names them,
  // and the execution section is what falls back to a typed model.
  const [provider] = defaultConfig.providers;
  assert.deepEqual(provider?.models, []);
  assert.equal(ConfigInputSchema.safeParse(defaultConfig).success, true);
});

void test('rejects a model list entry that repeats, is empty, or carries a bad effort', () => {
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

void test('rejects model profiles that reference an unavailable provider', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.models.execution.providerId = 'missing';
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('rejects fields outside the Direct configuration contract', () => {
  const invalid = { ...structuredClone(defaultConfig), routing: {} };
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('accepts an execution that carries a whole context-compaction policy', () => {
  assert.equal(
    ConfigInputSchema.safeParse(
      withCompaction({
        enabled: true,
        pressurePercent: 80,
        tailMinMessages: 6,
        summaryMaxChars: 6000,
        charBudget: 200000,
      }),
    ).success,
    true,
  );
});

void test('keeps an execution that names no context-compaction policy acceptable', () => {
  // No default is injected: an absent policy stays absent, and the consumer
  // applies its own defaults, as it does for `maxToolResultChars`.
  assert.deepEqual(ConfigInputSchema.parse(defaultConfig).execution, {
    maxTurns: 32,
  });
});

void test('rejects a context-compaction policy outside the shape the host stores', () => {
  const whole = {
    enabled: true,
    pressurePercent: 80,
    tailMinMessages: 6,
    summaryMaxChars: 6000,
    charBudget: 200000,
  };

  for (const contextCompaction of [
    { ...whole, pressurePercent: 40 },
    { ...whole, pressurePercent: 96 },
    { ...whole, pressurePercent: 80.5 },
    { ...whole, tailMinMessages: 0 },
    { ...whole, summaryMaxChars: 199 },
    { ...whole, charBudget: 999 },
    { ...whole, enabled: 'yes' },
    { enabled: true, pressurePercent: 80 },
    { ...whole, unknown: true },
  ]) {
    assert.equal(
      ConfigInputSchema.safeParse(withCompaction(contextCompaction)).success,
      false,
    );
  }
});

/** A configuration whose profile is the value under test, loosely typed. */
const withProfile = (profile: Record<string, unknown>): unknown => ({
  ...structuredClone(defaultConfig),
  profile,
});

/** The paths of the issues the schema raises for a configuration. */
const issuePaths = (configuration: unknown): string[] =>
  (ConfigInputSchema.safeParse(configuration).error?.issues ?? []).map(
    (issue) => issue.path.join('.'),
  );

void test('accepts a profile with a name, a time zone, or both at their limits', () => {
  for (const profile of [
    { timezone: 'UTC' },
    { name: 'a'.repeat(100) },
    { name: 'Ana' },
    { name: 'Ana', timezone: 'America/Sao_Paulo' },
  ]) {
    assert.equal(
      ConfigInputSchema.safeParse(withProfile(profile)).success,
      true,
      `profile ${JSON.stringify(profile)} was refused`,
    );
  }
});

void test('refuses a profile time zone this computer does not know, on that field', () => {
  const configuration = withProfile({ timezone: 'Mars/Olympus' });

  assert.equal(ConfigInputSchema.safeParse(configuration).success, false);
  assert.ok(issuePaths(configuration).includes('profile.timezone'));
});

void test('refuses a profile name that is blank, too long or on more than one line', () => {
  for (const name of ['', '   ', 'a'.repeat(101), 'Ana\nMaria']) {
    const configuration = withProfile({ name });

    assert.equal(
      ConfigInputSchema.safeParse(configuration).success,
      false,
      `name ${JSON.stringify(name)} was accepted`,
    );
    assert.ok(
      issuePaths(configuration).includes('profile.name'),
      `name ${JSON.stringify(name)} was not refused on profile.name`,
    );
  }
});

void test('refuses a profile field the host does not store', () => {
  const configuration = withProfile({
    name: 'Ana',
    email: 'ana@example.com',
  });

  assert.equal(ConfigInputSchema.safeParse(configuration).success, false);
  assert.ok(issuePaths(configuration).includes('profile'));
});

void test('keeps a configuration that names no profile without one', () => {
  assert.equal('profile' in ConfigInputSchema.parse(defaultConfig), false);
});

void test('rejects duplicate provider identifiers', () => {
  const invalid = structuredClone(defaultConfig);
  invalid.providers.push(structuredClone(invalid.providers[0]));
  assert.equal(ConfigInputSchema.safeParse(invalid).success, false);
});

void test('names the credential each provider secret field carries', () => {
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
      kind: 'openai',
      configuration: {},
      models: [{ name: 'local-model', reasonings: [] }],
    }),
    [],
  );
});

void test('rejects a provider that references a credential of the wrong kind', async () => {
  const harness = configHarness({
    credentials: [providerCredential, gitCredential],
  });
  const invalid = withProvider({
    ...providerOf(),
    configuration: {
      ...providerOf().configuration,
      token: gitCredential.id,
    },
  }) as ConfigInput;

  assert.deepEqual(await harness.service.replace(invalid), {
    status: 'invalid',
    message:
      'Provider openrouter token must reference a API_TOKEN credential, not a GIT one.',
  });
  assert.deepEqual(harness.writes, []);
});

void test('rejects a configuration that references an unstored credential', async () => {
  const harness = configHarness({ credentials: [providerCredential] });
  const invalid = structuredClone(defaultConfig);
  invalid.gitCredentialId = gitCredential.id;

  assert.deepEqual(await harness.service.replace(invalid), {
    status: 'invalid',
    message: 'The Git identity references a credential that is not stored.',
  });
  assert.deepEqual(harness.writes, []);
});

void test('answers a body the schema refuses as the invalid configuration it always was', async () => {
  const harness = configHarness();

  assert.deepEqual(
    await harness.service.replace({ ...defaultConfig, unknown: true }),
    { status: 'invalid', message: 'The Doric configuration is invalid.' },
  );
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.prepared, []);
});

void test('accepts a Git identity and a GitHub token of the right kinds', async () => {
  const harness = configHarness({
    credentials: [providerCredential, gitCredential],
  });
  const github: Credential = {
    id: '00000000-0000-4000-8000-00000000000b',
    kind: 'API_TOKEN',
    name: 'github',
    secret: 'ghp_stored',
  };
  harness.store([providerCredential, gitCredential, github]);

  const result = await harness.service.replace({
    ...structuredClone(defaultConfig),
    gitCredentialId: gitCredential.id,
    githubCredentialId: github.id,
  });

  assert.ok(result.status === 'replaced');
  assert.deepEqual(
    result.config.configuration.gitCredentialId,
    gitCredential.id,
  );
  assert.deepEqual(result.config.configuration.githubCredentialId, github.id);
  assert.deepEqual(harness.writes, [defaultConfig.models.execution.model]);
});

void test('refuses a configuration a bundled tool cannot read, before anything is built', async () => {
  const tool = {
    name: 'web',
    settings: [{ key: 'endpoint', label: 'Endpoint', required: true }],
  } as unknown as BoundTool;
  const harness = configHarness({ tools: [tool] });

  assert.deepEqual(await harness.service.replace(configured('needs-tool')), {
    status: 'invalid',
    message: 'Tool web requires a endpoint value.',
  });
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.prepared, []);

  const accepted = await harness.service.replace({
    ...configured('tool-set'),
    tools: { web: { endpoint: 'https://search.example.test' } },
  });
  assert.equal(accepted.status, 'replaced');
});

void test('fills the listed models from the catalog models/v1 reads for their kind', async () => {
  const read: { kind: string; configuration: Record<string, string> }[] = [];
  const harness = configHarness({
    catalog: async (input) => {
      read.push(input);
      return {
        status: 'read',
        models: [
          {
            id: 'listed/model',
            reasonings: ['low', 'high'],
            defaultEffort: 'high',
          },
        ],
      } as unknown as CatalogResult;
    },
  });
  const configuration: ConfigInput = {
    ...structuredClone(defaultConfig),
    providers: [
      {
        ...providerOf(),
        models: [{ name: 'listed/model', reasonings: [] }],
      },
    ],
    models: {
      execution: { providerId: 'openrouter', model: 'listed/model' },
    },
  };

  const result = await harness.service.replace(configuration);

  assert.ok(result.status === 'replaced');
  assert.deepEqual(read, [
    { kind: 'openrouter', configuration: providerOf().configuration },
  ]);
  assert.deepEqual(result.config.configuration.providers[0]?.models, [
    {
      name: 'listed/model',
      reasonings: ['low', 'high'],
      defaultEffort: 'high',
    },
  ]);
  assert.deepEqual(result.config.configuration.models.execution, {
    providerId: 'openrouter',
    model: 'listed/model',
    effort: 'high',
  });
});

void test('a kind whose catalog is its model list stores every model the catalog lists, in its order', async () => {
  const harness = configHarness({
    catalogListed: ['openrouter'],
    catalog: async () =>
      ({
        status: 'read',
        models: [
          {
            id: 'listed/new',
            reasonings: ['low', 'medium', 'high'],
            parameters: [],
            defaultEffort: 'medium',
            mandatory: false,
          },
          {
            id: 'listed/plain',
            reasonings: [],
            parameters: [],
            mandatory: false,
          },
        ],
      }) as CatalogResult,
  });
  const configuration: ConfigInput = {
    ...structuredClone(defaultConfig),
    providers: [
      {
        ...providerOf(),
        // A model the catalog no longer lists is not kept: the list is the
        // catalog's, not an operator's.
        models: [{ name: 'listed/retired', reasonings: ['low'] }],
      },
    ],
    models: { execution: { providerId: 'openrouter', model: 'listed/new' } },
  };

  const result = await harness.service.replace(configuration);

  assert.ok(result.status === 'replaced');
  assert.deepEqual(result.config.configuration.providers[0]?.models, [
    {
      name: 'listed/new',
      reasonings: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    },
    { name: 'listed/plain', reasonings: [] },
  ]);
  assert.deepEqual(result.config.configuration.models.execution, {
    providerId: 'openrouter',
    model: 'listed/new',
    effort: 'medium',
  });
});

void test('a catalog-listed provider with no models yet is read, and a failed read keeps its list', async () => {
  let answer: CatalogResult = { status: 'failed' };
  const harness = configHarness({
    catalogListed: ['openrouter'],
    catalog: async () => answer,
  });
  const configuration = (models: ConfigInput['providers'][number]['models']) =>
    ({
      ...structuredClone(defaultConfig),
      providers: [{ ...providerOf(), models }],
    }) as ConfigInput;

  const failed = await harness.service.replace(
    configuration([{ name: 'kept/model', reasonings: [] }]),
  );
  assert.ok(failed.status === 'replaced');
  assert.deepEqual(failed.config.configuration.providers[0]?.models, [
    { name: 'kept/model', reasonings: [] },
  ]);

  answer = {
    status: 'read',
    models: [
      { id: 'first/model', reasonings: [], parameters: [], mandatory: false },
    ],
  };
  const read = await harness.service.replace(configuration([]));
  assert.ok(read.status === 'replaced');
  assert.deepEqual(read.config.configuration.providers[0]?.models, [
    { name: 'first/model', reasonings: [] },
  ]);
});

void test('builds the candidate providers before storing, then activates the stored revision', async () => {
  const harness = configHarness();

  const result = await harness.service.replace(configured('next'));

  assert.ok(result.status === 'replaced');
  assert.deepEqual(harness.prepared, [
    { model: 'next', revision: undefined },
    { model: 'next', revision: 2 },
  ]);
  assert.deepEqual(await harness.service.current(), result.config);
});

void test('serializes concurrent replacements in request order', async () => {
  const harness = configHarness({ blockedBuild: 'first' });
  const firstWrite = harness.service.replace(configured('first'));
  const secondWrite = harness.service.replace(configured('second'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.writes, []);

  harness.releaseBuild();
  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(harness.writes, ['first', 'second']);
  assert.equal(
    (await harness.service.current()).configuration.models.execution.model,
    'second',
  );
});

void test('keeps the active configuration and accepts later replacements after a build failure', async () => {
  const harness = configHarness({ failedBuild: 'broken-build' });

  assert.deepEqual(await harness.service.replace(configured('broken-build')), {
    status: 'rejected',
  });
  assert.deepEqual(harness.writes, []);
  assert.equal(
    (await harness.service.current()).configuration.models.execution.model,
    defaultConfig.models.execution.model,
  );

  assert.equal(
    (await harness.service.replace(configured('recovered'))).status,
    'replaced',
  );
  assert.deepEqual(harness.writes, ['recovered']);
  assert.equal(
    (await harness.service.current()).configuration.models.execution.model,
    'recovered',
  );
});

void test('keeps the active configuration when persistent replacement fails', async () => {
  const harness = configHarness({ failedWrite: 'broken-store' });
  const original = await harness.service.current();

  assert.deepEqual(await harness.service.replace(configured('broken-store')), {
    status: 'rejected',
  });
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(await harness.service.current(), original);

  const result = await harness.service.replace(configured('recovered'));
  assert.ok(result.status === 'replaced');
  assert.equal(result.config.configuration.models.execution.model, 'recovered');
  assert.deepEqual(await harness.service.current(), result.config);
});

void test('loads the stored configuration once, and again after a failed load', async () => {
  let loads = 0;
  let fail = true;
  const service = createConfigService({
    store: {
      load: async () => {
        loads += 1;
        if (fail) throw new Error('database unavailable');
        return snapshot(defaultConfig, 1);
      },
      replace: async () => {
        throw new Error('unexpected write');
      },
    },
    credentials: async () => credentialResolver(),
    tools: () => [],
    models: {
      catalog: async () => ({ status: 'absent' }),
      kind: async () => undefined,
      prepare: async () => undefined,
    },
  });

  await assert.rejects(service.current(), /database unavailable/);
  fail = false;
  assert.deepEqual(await service.current(), snapshot(defaultConfig, 1));
  assert.deepEqual(await service.current(), snapshot(defaultConfig, 1));
  assert.equal(loads, 2);
});

interface ConfigHarnessOptions {
  readonly credentials?: readonly Credential[];
  readonly tools?: readonly BoundTool[];
  readonly catalog?: (input: {
    kind: string;
    configuration: Record<string, string>;
  }) => Promise<CatalogResult>;
  /** The kinds `models/v1.kind` describes as listing their catalog. */
  readonly catalogListed?: readonly string[];
  readonly blockedBuild?: string;
  readonly failedBuild?: string;
  readonly failedWrite?: string;
}

const configHarness = ({
  credentials = [providerCredential],
  tools = [],
  catalog = async () => ({ status: 'absent' }),
  catalogListed = [],
  blockedBuild,
  failedBuild,
  failedWrite,
}: ConfigHarnessOptions = {}) => {
  let revision = 1;
  const writes: string[] = [];
  const prepared: { model: string; revision: number | undefined }[] = [];
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
  /** `models/v1.prepare`: a bare configuration, or a stored snapshot. */
  const prepare = async (input: Readonly<Record<string, unknown>>) => {
    const stored =
      typeof input.revision === 'number'
        ? (input as unknown as DoricConfig)
        : undefined;
    const configuration = (stored?.configuration ?? input) as ConfigInput;
    const model = configuration.models.execution.model;
    if (model === blockedBuild) await buildGate;
    if (model === failedBuild) throw new Error('providers unavailable');
    prepared.push({ model, revision: stored?.revision });
  };
  const service = createConfigService({
    store,
    credentials: async () => credentialResolver(() => stored),
    tools: () => tools,
    models: {
      catalog,
      // The llms kinds as models/v1 describes them, each flagged when the test
      // says its catalog is its model list.
      kind: async (id: string) => {
        const kind = providerKinds.find((candidate) => candidate.id === id);
        if (kind === undefined) return undefined;
        return {
          ...kind,
          fields: [...kind.fields],
          lists: [...kind.lists],
          modelsFromCatalog: catalogListed.includes(id),
        } as unknown as ModelKindDescriptor;
      },
      prepare,
    },
  });
  return {
    service,
    writes,
    prepared,
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

/**
 * `settings/v1` held in memory: one space whose value is validated by the
 * space's own schema on every write, as the settings provider does.
 */
const memorySettings = (value: unknown) => {
  let entry: SettingsEntry = {
    value,
    revision: 1,
    version: '1.0.0',
    updatedAt: new Date(1000).toISOString(),
    generation: 1,
  };

  return {
    entry: async () => entry,
    set: async (definition: SettingsDefinition, next: unknown) => {
      entry = {
        value: definition.schema.parse(next),
        revision: entry.revision + 1,
        version: entry.version,
        updatedAt: new Date((entry.revision + 1) * 1000).toISOString(),
        generation: entry.generation + 1,
      };
      return entry;
    },
  } as unknown as Settings;
};

/** The configuration service over the real store, reading `settings`. */
const storedService = (settings: Settings) =>
  createConfigService({
    store: createConfigStore({
      settings,
      definition: defineSettings({
        id: configurationSettingsId,
        schema: ConfigInputSchema,
      }) as unknown as ConfigurationSettings,
      track: () => undefined,
    }),
    credentials: async () => credentialResolver(() => [providerCredential]),
    tools: () => [],
    models: {
      catalog: async () => ({ status: 'absent' }),
      kind: async () => undefined,
      prepare: async () => undefined,
    },
  });

void test('stores a profile and answers it after the host loads again', async () => {
  const settings = memorySettings(structuredClone(defaultConfig));
  const profile = { name: 'Ana', timezone: 'America/Sao_Paulo' };

  const result = await storedService(settings).replace({
    ...structuredClone(defaultConfig),
    profile,
  });

  assert.equal(result.status, 'replaced');
  assert.ok(result.status === 'replaced');
  assert.deepEqual(result.config.configuration.profile, profile);

  const reloaded = await storedService(settings).current();
  assert.deepEqual(reloaded.configuration.profile, profile);
});

void test('loads a configuration stored before profiles existed without one', async () => {
  const settings = memorySettings(structuredClone(defaultConfig));

  const loaded = await storedService(settings).current();

  assert.equal('profile' in loaded.configuration, false);
});
