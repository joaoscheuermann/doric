import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  addModel,
  addProvider,
  applyProviderDraft,
  type CatalogModel,
  type Configuration,
  type Credential,
  catalogFeatures,
  configurationIssue,
  credentialCreate,
  credentialDraftOf,
  credentialFields,
  credentialIssue,
  credentialKindLabel,
  credentialLabel,
  credentialsOfKind,
  credentialUpdate,
  effortLabel,
  emptyCredentialDraft,
  emptyProviderDraft,
  enableExecutionReasoning,
  isReasoningEffort,
  isSameConfiguration,
  isUsableChoice,
  kindFillsModelEfforts,
  kindOf,
  modelChoiceKey,
  modelDefaultEffort,
  modelEfforts,
  modelGroups,
  modelThinkingEffort,
  type ProviderConfiguration,
  type ProviderDraft,
  type ProviderField,
  type ProviderKind,
  providerAddress,
  providerDraftOf,
  providerFromDraft,
  providerIssue,
  providerLabel,
  providerRows,
  providerValues,
  type ReasoningEffort,
  reasoningEfforts,
  removeModel,
  removeProvider,
  replaceProvider,
  searchModelGroups,
  selectModelChoice,
  setExecutionEffort,
  turnsFromInput,
  updateCredentialChoice,
  updatedAtLabel,
  updateModel,
  updateProvider,
  updateTurnLimit,
} from '../src/domain/config';

/** A stored credential of the kind the id names, as the host would answer it. */
const credential = (
  id: string,
  kind: Credential['kind'] = 'API_TOKEN',
): Credential => ({
  id,
  kind,
  name: id,
  hasSecret: true,
});

/**
 * A provider catalog that covers every field kind and both per-provider lists,
 * plus one kind that keeps none, so a case can prove what the renderer draws
 * comes from the catalog rather than from a shape it assumes.
 */
const kinds: readonly ProviderKind[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI and compatible endpoints.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
      { key: 'token', label: 'API token', kind: 'secret', required: true },
      {
        key: 'region',
        label: 'Region',
        kind: 'enum',
        required: false,
        options: ['us', 'eu'],
      },
      { key: 'weight', label: 'Weight', kind: 'number', required: false },
      { key: 'note', label: 'Note', kind: 'text', required: false },
    ],
    lists: ['models', 'reasonings'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'A local server.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    ],
    lists: [],
  },
];

/** The value a field starts with, so a fixture satisfies every field kind. */
const valueFor = (field: ProviderField, id: string): string =>
  field.kind === 'url'
    ? 'https://api.example.com'
    : field.kind === 'secret'
      ? `${id}-credential`
      : field.kind === 'enum'
        ? (field.options?.[0] ?? '')
        : field.kind === 'number'
          ? '1'
          : '';

/** One provider of a kind, carrying every field and list the kind declares. */
const provider = (
  id: string,
  kind: ProviderKind = kinds[0],
): ProviderConfiguration => ({
  id,
  kind: kind.id,
  configuration: Object.fromEntries(
    kind.fields.map((field) => [field.key, valueFor(field, id)]),
  ),
  ...(kind.lists.includes('models')
    ? {
        models: [
          {
            name: 'gpt-5',
            ...(kind.lists.includes('reasonings')
              ? { reasonings: ['medium'] }
              : {}),
          },
        ],
      }
    : {}),
});

/** The provider with one configuration field set to a value a case names. */
const withField = (
  provider: ProviderConfiguration,
  key: string,
  value: string,
): ProviderConfiguration => ({
  ...provider,
  configuration: { ...provider.configuration, [key]: value },
});

/** A configuration the host would accept, which each case then breaks once. */
const configuration = (
  overrides: Partial<Configuration> = {},
): Configuration => ({
  providers: [provider('openai')],
  models: {
    execution: { providerId: 'openai', model: 'gpt-5', effort: 'medium' },
  },
  execution: { maxTurns: 8 },
  ...overrides,
});

const withExecution = (
  base: Configuration,
  patch: Configuration['models']['execution'],
): Configuration => ({ ...base, models: { execution: patch } });

const withProviders = (
  base: Configuration,
  providers: readonly ProviderConfiguration[],
): Configuration => ({ ...base, providers });

/** A configuration the host would accept, which each case then breaks once. */
describe('configuration rules', () => {
  test('accepts a configuration the host would accept', () => {
    assert.equal(configurationIssue(configuration(), kinds), undefined);
  });

  test("accepts values at the host's own bounds", () => {
    const id = 'p'.repeat(128);
    assert.equal(
      configurationIssue(
        configuration({
          providers: [provider(id)],
          models: {
            execution: {
              providerId: id,
              model: 'm'.repeat(512),
              effort: 'xhigh',
            },
          },
        }),
        kinds,
      ),
      undefined,
    );
  });

  test('requires at least one provider', () => {
    assert.equal(
      configurationIssue(withProviders(configuration(), []), kinds),
      'Add at least one provider.',
    );
  });

  test('requires every provider id to be named and bounded', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [provider('  ')]),
        kinds,
      ),
      'Enter an id between 1 and 128 characters for every provider.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [provider('p'.repeat(129))]),
        kinds,
      ),
      'Enter an id between 1 and 128 characters for every provider.',
    );
  });

  test('requires provider ids to be unique', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          provider('openai'),
          provider('openai'),
        ]),
        kinds,
      ),
      'Provider ids must be unique.',
    );
  });

  test('requires every required field the kind declares', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'endpoint', ''),
        ]),
        kinds,
      ),
      'Enter Endpoint for openai.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'token', ''),
        ]),
        kinds,
      ),
      'Enter API token for openai.',
    );
  });

  test('requires an address field to be http or https', () => {
    for (const endpoint of ['api.example.com', 'ftp://api.example.com']) {
      assert.equal(
        configurationIssue(
          withProviders(configuration(), [
            withField(provider('openai'), 'endpoint', endpoint),
          ]),
          kinds,
        ),
        'Enter an http:// or https:// address for Endpoint on openai.',
      );
    }
  });

  test('requires a number field to parse finite', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'weight', 'heavy'),
        ]),
        kinds,
      ),
      'Enter a number for Weight on openai.',
    );
  });

  test('requires an enum field to name one of the values the kind offers', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'region', 'apac'),
        ]),
        kinds,
      ),
      'Choose Region for openai.',
    );
  });

  test('refuses a field the kind does not declare', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'legacy', 'x'),
        ]),
        kinds,
      ),
      'Provider openai carries a field its kind does not declare.',
    );
  });

  test('requires the lists a kind keeps, and refuses the ones it does not', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), models: undefined },
        ]),
        kinds,
      ),
      'Provider openai must carry its models.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('ollama', kinds[1]), models: [{ name: 'llama' }] },
        ]),
        kinds,
      ),
      "Provider ollama's kind does not keep models.",
    );
  });

  test('requires every model to be named once, with known efforts', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          {
            ...provider('openai'),
            models: [{ name: 'gpt-5', reasonings: [] }, { name: '  ' }],
          },
        ]),
        kinds,
      ),
      'Every model must be named for openai.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          {
            ...provider('openai'),
            models: [
              { name: 'gpt-5', reasonings: [] },
              { name: 'gpt-5', reasonings: [] },
            ],
          },
        ]),
        kinds,
      ),
      'Every model must be unique for openai.',
    );
  });

  test('requires every reasoning effort to be known and unique per model', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          {
            ...provider('openai'),
            models: [{ name: 'gpt-5', reasonings: ['low', 'low'] }],
          },
        ]),
        kinds,
      ),
      'Every reasoning effort must be unique for gpt-5.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          {
            ...provider('openai'),
            models: [{ name: 'gpt-5', reasonings: ['extreme'] }],
          },
        ]),
        kinds,
      ),
      'Choose a known reasoning effort for gpt-5.',
    );
  });

  test('requires a provider to name a kind the catalog declares', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), kind: 'mystery' },
        ]),
        kinds,
      ),
      'Choose a kind for openai.',
    );
  });

  test('requires the execution model to name a configured provider', () => {
    assert.equal(
      configurationIssue(
        withExecution(configuration(), {
          providerId: 'anthropic',
          model: 'gpt-5',
          effort: 'medium',
        }),
        kinds,
      ),
      'Choose the provider that runs prompts.',
    );
  });

  test('requires a model name within the host bound', () => {
    for (const model of ['   ', 'm'.repeat(513)]) {
      assert.equal(
        configurationIssue(
          withExecution(configuration(), {
            providerId: 'openai',
            model,
            effort: 'medium',
          }),
          kinds,
        ),
        'Enter a model between 1 and 512 characters.',
      );
    }
  });

  test('requires a reasoning effort the endpoint names', () => {
    assert.equal(
      configurationIssue(
        withExecution(configuration(), {
          providerId: 'openai',
          model: 'gpt-5',
          effort: 'extreme' as ReasoningEffort,
        }),
        kinds,
      ),
      'Choose a reasoning effort.',
    );
  });

  test('chooses the effort for a model that lists efforts', () => {
    assert.equal(
      configurationIssue(
        withExecution(configuration(), {
          providerId: 'openai',
          model: 'gpt-5',
        }),
        kinds,
      ),
      'Choose a reasoning effort.',
    );
  });

  test('carries no effort for a model that lists none', () => {
    const listed = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [{ name: 'gpt-5', reasonings: [] }],
      },
    ]);

    assert.equal(
      configurationIssue(
        withExecution(listed, { providerId: 'openai', model: 'gpt-5' }),
        kinds,
      ),
      undefined,
    );
  });

  test('requires a positive whole turn limit', () => {
    for (const maxTurns of [0, -1, 2.5, Number.NaN]) {
      assert.equal(
        configurationIssue(configuration({ execution: { maxTurns } }), kinds),
        'Enter a turn limit of 1 or more.',
      );
    }
  });
});

describe('the catalog a provider page offers', () => {
  /** An OpenRouter-shaped kind: one required secret, optional URLs, both lists. */
  const openRouter: ProviderKind = {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'A catalog and a chat API.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'url', required: false },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
      {
        key: 'modelsUrl',
        label: 'Models URL',
        kind: 'url',
        required: false,
        advanced: true,
      },
    ],
    lists: ['models', 'reasonings'],
  };

  const model = (
    id: string,
    parameters: readonly string[],
    reasonings: readonly ReasoningEffort[] = [],
  ): CatalogModel => ({ id, parameters, reasonings });

  test('states one column per feature, the ones that decide a call first', () => {
    assert.deepEqual(
      catalogFeatures([
        model('a', ['temperature', 'tools', 'logprobs']),
        model('b', ['tools', 'reasoning_effort']),
      ]),
      ['tools', 'reasoning_effort', 'logprobs', 'temperature'],
    );
    assert.deepEqual(catalogFeatures([]), []);
  });

  test('adds a chosen model at the end, and never twice', () => {
    const offered = addModel([], { name: ' a-model ' });

    assert.deepEqual(offered, [{ name: 'a-model' }]);
    assert.deepEqual(addModel(offered, { name: 'a-model' }), offered);
    assert.deepEqual(addModel(offered, { name: 'b-model' }), [
      { name: 'a-model' },
      { name: 'b-model' },
    ]);
  });

  test('removes one model and keeps the order of the rest', () => {
    assert.deepEqual(
      removeModel([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 'b'),
      [{ name: 'a' }, { name: 'c' }],
    );
  });

  test('names a catalog read after the fields a draft filled', () => {
    assert.deepEqual(
      providerValues(
        {
          id: '',
          kind: openRouter.id,
          configuration: { endpoint: '', token: ' cred ', modelsUrl: '' },
          models: [],
        },
        openRouter,
      ),
      { kind: 'openrouter', configuration: { token: 'cred' } },
    );
  });

  test('reads an effort only from the closed set', () => {
    assert.equal(isReasoningEffort('max'), true);
    assert.equal(isReasoningEffort('ultra'), false);
  });
});

describe('credential choice rules', () => {
  test('accepts a configuration that names no credentials', () => {
    assert.equal(configurationIssue(configuration(), kinds), undefined);
  });

  test('holds a provider secret to a non-empty value, not a stored one', () => {
    // The section's own rule asks only that a required secret is named; whether
    // the store still holds it is the provider page's check, where the store is in hand.
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'token', 'deleted-credential'),
        ]),
        kinds,
      ),
      undefined,
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          withField(provider('openai'), 'token', ''),
        ]),
        kinds,
      ),
      'Enter API token for openai.',
    );
  });

  test('holds for a configuration that names both choices', () => {
    assert.equal(
      configurationIssue(
        configuration({
          gitCredentialId: 'identity',
          githubCredentialId: 'token',
        }),
        kinds,
      ),
      undefined,
    );
  });
});

describe('credential store vocabulary', () => {
  test('names each kind for a reader', () => {
    assert.equal(credentialKindLabel('API_TOKEN'), 'API token');
    assert.equal(
      credentialKindLabel('USERNAME_PASSWORD'),
      'Username and password',
    );
    assert.equal(credentialKindLabel('GIT'), 'Git identity');
  });

  test('states the fields each kind carries', () => {
    assert.deepEqual(credentialFields('API_TOKEN'), ['secret']);
    assert.deepEqual(credentialFields('USERNAME_PASSWORD'), [
      'username',
      'secret',
    ]);
    assert.deepEqual(credentialFields('GIT'), ['username', 'email']);
  });

  test('offers only the credentials of the kind an integration needs', () => {
    const stored = [
      credential('token', 'API_TOKEN'),
      credential('identity', 'GIT'),
      credential('registry', 'USERNAME_PASSWORD'),
    ];

    assert.deepEqual(
      credentialsOfKind(stored, 'GIT').map(({ id }) => id),
      ['identity'],
    );
    assert.deepEqual(
      credentialsOfKind(stored, 'API_TOKEN').map(({ id }) => id),
      ['token'],
    );
  });

  test('labels a credential by name, with its username when it has one', () => {
    assert.equal(credentialLabel(credential('token')), 'token');
    assert.equal(
      credentialLabel({
        ...credential('identity', 'GIT'),
        username: 'octocat',
      }),
      'identity (octocat)',
    );
  });

  test('accepts a choice only while the store still holds that credential', () => {
    const stored = [
      credential('token', 'API_TOKEN'),
      credential('identity', 'GIT'),
    ];

    assert.equal(isUsableChoice(stored, 'token', 'API_TOKEN'), true);
    // The kind an integration needs is part of the choice, not just the id.
    assert.equal(isUsableChoice(stored, 'identity', 'API_TOKEN'), false);
    assert.equal(isUsableChoice(stored, undefined, 'API_TOKEN'), false);
    assert.equal(isUsableChoice(stored, 'deleted', 'API_TOKEN'), false);
  });
});

describe('credential drafts', () => {
  test('accepts a draft that satisfies its kind', () => {
    assert.equal(
      credentialIssue({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_x',
      }),
      undefined,
    );
    assert.equal(
      credentialIssue({
        kind: 'USERNAME_PASSWORD',
        name: 'registry',
        username: 'octocat',
        secret: 'hunter2',
      }),
      undefined,
    );
    assert.equal(
      credentialIssue({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      }),
      undefined,
    );
  });

  test('names the fields a kind still needs', () => {
    assert.equal(
      credentialIssue({ kind: 'API_TOKEN', name: 'openrouter' }),
      'A API token credential needs secret.',
    );
    assert.equal(
      credentialIssue({ kind: 'GIT', name: 'github', username: 'octocat' }),
      'A Git identity credential needs email.',
    );
  });

  test('refuses a field the kind does not carry', () => {
    assert.equal(
      credentialIssue({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_x',
        username: 'octocat',
      }),
      'A API token credential carries no username.',
    );
    assert.equal(
      credentialIssue({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
        secret: 'sk_x',
      }),
      'A Git identity credential carries no secret.',
    );
  });

  test('requires a name within the host bound', () => {
    assert.equal(
      credentialIssue({ kind: 'API_TOKEN', name: '  ', secret: 'sk_x' }),
      'Enter a name between 1 and 128 characters.',
    );
    assert.equal(
      credentialIssue({
        kind: 'API_TOKEN',
        name: 'n'.repeat(129),
        secret: 'sk_x',
      }),
      'Enter a name between 1 and 128 characters.',
    );
  });

  test('refuses a secret carrying whitespace rather than trimming it', () => {
    assert.equal(
      credentialIssue({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_x\nsk_y',
      }),
      'Enter a secret with no spaces or line breaks.',
    );
  });

  test('refuses an email the host would refuse', () => {
    assert.equal(
      credentialIssue({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'not-an-address',
      }),
      'Enter an email address.',
    );
  });

  test('creates only the fields the kind carries', () => {
    assert.deepEqual(
      credentialCreate({
        kind: 'API_TOKEN',
        name: '  openrouter  ',
        secret: 'sk_x',
        username: 'ignored',
      }),
      { kind: 'API_TOKEN', name: 'openrouter', secret: 'sk_x' },
    );
    assert.deepEqual(
      credentialCreate({
        kind: 'GIT',
        name: 'github',
        username: ' octocat ',
        email: ' octocat@example.com ',
      }),
      {
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      },
    );
  });

  test('keeps a stored secret when the edit field is left empty', () => {
    const stored = { ...credential('openrouter'), name: 'openrouter' };

    assert.deepEqual(credentialUpdate(credentialDraftOf(stored), stored), {
      name: 'openrouter',
      secret: null,
    });
  });

  test('sets a secret the edit field carries', () => {
    const stored = { ...credential('openrouter'), name: 'openrouter' };
    const draft = { ...credentialDraftOf(stored), secret: 'sk_rotated' };

    assert.equal(credentialUpdate(draft, stored).secret, 'sk_rotated');
  });

  test('omits the fields the edited kind does not carry', () => {
    const stored = { ...credential('identity', 'GIT'), username: 'octocat' };

    const patch = credentialUpdate(credentialDraftOf(stored), stored);

    // Absent, not `''`: the host reads `''` as a cleared field, and a cleared
    // field is still one the credential carries, so `GIT` refuses the patch.
    assert.ok(!('secret' in patch));
    assert.equal(patch.username, 'octocat');
  });

  test('sends the fields its kind carries and no others', () => {
    const stored = { ...credential('token'), name: 'token' };
    const draft = { ...credentialDraftOf(stored), secret: 'sk_x' };

    const patch = credentialUpdate(draft, stored);

    assert.deepEqual(Object.keys(patch).sort(), ['name', 'secret']);
    assert.equal(patch.secret, 'sk_x');
  });

  test('never reads a stored secret into the draft that edits it', () => {
    const draft = credentialDraftOf({ ...credential('token'), name: 'token' });

    assert.equal(draft.secret, undefined);
    assert.equal(draft.id, 'token');
  });

  test('opens a blank draft that asks for exactly its kind', () => {
    assert.deepEqual(emptyCredentialDraft('GIT'), { kind: 'GIT', name: '' });
  });
});

describe('configuration comparison', () => {
  test('holds for the same values in a different object', () => {
    assert.ok(isSameConfiguration(configuration(), configuration()));
  });

  test('breaks when any field the host stores changes', () => {
    const base = configuration();
    const changed: readonly Configuration[] = [
      withProviders(base, [provider('openai'), provider('anthropic')]),
      withProviders(base, [provider('azure')]),
      withProviders(base, [provider('openai', kinds[1])]),
      withProviders(base, [
        withField(provider('openai'), 'endpoint', 'https://other.example.com'),
      ]),
      withProviders(base, [
        withField(provider('openai'), 'token', 'other-credential'),
      ]),
      withProviders(base, [
        {
          ...provider('openai'),
          models: [{ name: 'gpt-5-mini', reasonings: ['medium'] }],
        },
      ]),
      withProviders(base, [
        {
          ...provider('openai'),
          models: [{ name: 'gpt-5', reasonings: ['high'] }],
        },
      ]),
      updateModel(base, { providerId: 'anthropic' }),
      updateModel(base, { model: 'gpt-5-mini' }),
      updateModel(base, { effort: 'high' }),
      updateTurnLimit(base, 16),
      updateCredentialChoice(base, 'gitCredentialId', 'identity'),
      updateCredentialChoice(base, 'githubCredentialId', 'token'),
    ];

    for (const candidate of changed) {
      assert.equal(isSameConfiguration(base, candidate), false);
    }
  });

  test('holds for a configuration that names no credentials', () => {
    assert.ok(
      isSameConfiguration(
        configuration(),
        configuration({ gitCredentialId: undefined }),
      ),
    );
  });
});

describe('the execution effort follows the model it names', () => {
  test('lists the efforts the model names, and none for a model nothing lists', () => {
    assert.deepEqual(modelEfforts(configuration(), 'openai', 'gpt-5'), [
      'medium',
    ]);
    assert.deepEqual(modelEfforts(configuration(), 'openai', 'gpt-5-mini'), []);
  });

  test('keeps the chosen effort while the model lists efforts', () => {
    assert.equal(
      updateModel(configuration(), { effort: 'high' }).models.execution.effort,
      'high',
    );
  });

  test('resolves the effort away when the chosen model lists none', () => {
    const listed = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [{ name: 'gpt-5', reasonings: [] }],
      },
    ]);

    assert.deepEqual(
      updateModel(listed, { providerId: 'openai', model: 'gpt-5' }).models
        .execution,
      { providerId: 'openai', model: 'gpt-5' },
    );
  });

  test('tells a kind whose own catalog states the efforts', () => {
    assert.equal(kindFillsModelEfforts(kinds[0]), false);
    assert.equal(
      kindFillsModelEfforts({
        ...kinds[0],
        fields: [
          ...kinds[0].fields,
          {
            key: 'modelsUrl',
            label: 'Models URL',
            kind: 'url',
            required: false,
            advanced: true,
          },
        ],
      }),
      true,
    );
  });
});

describe('the execution profile a footer picker edits', () => {
  test('sets the effort a model lists, and clears it when none is named', () => {
    assert.equal(
      setExecutionEffort(configuration(), 'high').models.execution.effort,
      'high',
    );
    assert.deepEqual(
      setExecutionEffort(configuration(), undefined).models.execution,
      { providerId: 'openai', model: 'gpt-5' },
    );
  });

  test('reads a model choice back into the profile it names', () => {
    const key = modelChoiceKey('openai', 'gpt-5-mini');

    assert.equal(
      selectModelChoice(configuration(), key).models.execution.model,
      'gpt-5-mini',
    );
    assert.deepEqual(selectModelChoice(configuration(), key).models.execution, {
      providerId: 'openai',
      model: 'gpt-5-mini',
    });
  });

  test('leaves the profile alone for a key that names no provider', () => {
    const base = configuration();

    assert.deepEqual(
      selectModelChoice(base, 'gpt-5').models.execution,
      base.models.execution,
    );
  });
});

describe('the models the execution picker offers', () => {
  test('groups every provider under its label, and leaves a single provider unnamed', () => {
    assert.deepEqual(modelGroups(configuration()), [
      {
        label: undefined,
        choices: [{ label: 'gpt-5', value: modelChoiceKey('openai', 'gpt-5') }],
      },
    ]);

    const two = withProviders(configuration(), [
      provider('openai'),
      provider('anthropic'),
    ]);

    assert.deepEqual(
      modelGroups(two).map((group) => group.label),
      ['openai', 'anthropic'],
    );
  });

  test('shows a model no provider lists, first in the group its provider names', () => {
    const groups = modelGroups(
      withExecution(configuration(), {
        providerId: 'openai',
        model: 'unlisted',
      }),
    );

    assert.deepEqual(groups[0]?.choices[0], {
      label: 'unlisted',
      value: modelChoiceKey('openai', 'unlisted'),
    });
  });

  test('narrows the groups to a matching name, and drops the emptied ones', () => {
    const base = withProviders(configuration(), [
      { ...provider('openai'), models: [{ name: 'gpt-5' }] },
      { ...provider('anthropic'), models: [{ name: 'claude-sonnet' }] },
    ]);
    const groups = modelGroups(base);

    assert.deepEqual(
      searchModelGroups(groups, 'gpt').map((group) =>
        group.choices.map((choice) => choice.label),
      ),
      [['gpt-5']],
    );
    assert.deepEqual(searchModelGroups(groups, '  '), groups);
    assert.deepEqual(searchModelGroups(groups, 'nope'), []);
  });

  test("names the effort a model's own catalog calls its default, and none otherwise", () => {
    const named = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [
          {
            name: 'gpt-5',
            reasonings: ['high', 'medium'],
            defaultEffort: 'high',
          },
        ],
      },
    ]);

    assert.equal(modelDefaultEffort(named, 'openai', 'gpt-5'), 'high');

    // A default the model does not list names no effort at all.
    const unlisted = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [
          { name: 'gpt-5', reasonings: ['medium'], defaultEffort: 'high' },
        ],
      },
    ]);

    assert.equal(modelDefaultEffort(unlisted, 'openai', 'gpt-5'), undefined);
    assert.equal(
      modelDefaultEffort(configuration(), 'openai', 'gpt-5'),
      undefined,
    );
  });

  test('starts a model at the effort its catalog names, and otherwise at its first other than none', () => {
    const named = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [
          {
            name: 'gpt-5',
            reasonings: ['high', 'medium', 'low'],
            defaultEffort: 'high',
          },
        ],
      },
    ]);

    assert.equal(modelThinkingEffort(named, 'openai', 'gpt-5'), 'high');

    const unnamed = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [{ name: 'gpt-5', reasonings: ['none', 'low', 'high'] }],
      },
    ]);

    assert.equal(modelThinkingEffort(unnamed, 'openai', 'gpt-5'), 'low');

    const defaultOff = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [
          {
            name: 'gpt-5',
            reasonings: ['none', 'low'],
            defaultEffort: 'none',
          },
        ],
      },
    ]);
    assert.equal(modelThinkingEffort(defaultOff, 'openai', 'gpt-5'), 'low');

    const onlyOff = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [{ name: 'gpt-5', reasonings: ['none'] }],
      },
    ]);
    assert.equal(modelThinkingEffort(onlyOff, 'openai', 'gpt-5'), 'none');

    // A default the model does not list is no default at all.
    const unlisted = withProviders(configuration(), [
      {
        ...provider('openai'),
        models: [
          { name: 'gpt-5', reasonings: ['medium'], defaultEffort: 'high' },
        ],
      },
    ]);

    assert.equal(modelThinkingEffort(unlisted, 'openai', 'gpt-5'), 'medium');
    assert.equal(
      modelThinkingEffort(configuration(), 'openai', 'gpt-5-mini'),
      undefined,
    );
  });

  test('enables reasoning from a stored off choice only when the model offers it', () => {
    const off = withExecution(configuration(), {
      providerId: 'openai',
      model: 'gpt-5',
      effort: 'none',
    });
    assert.equal(
      enableExecutionReasoning(off).models.execution.effort,
      'medium',
    );

    const unavailable = withExecution(off, {
      providerId: 'openai',
      model: 'gpt-5-mini',
    });
    assert.deepEqual(
      enableExecutionReasoning(unavailable).models.execution,
      unavailable.models.execution,
    );
  });

  test("switches the profile to the model it names, at that model's own default", () => {
    const base = withExecution(
      withProviders(configuration(), [
        {
          ...provider('openai'),
          models: [
            { name: 'gpt-5', reasonings: ['medium'] },
            {
              name: 'claude',
              reasonings: ['high', 'medium', 'low'],
              defaultEffort: 'high',
            },
          ],
        },
      ]),
      { providerId: 'openai', model: 'gpt-5', effort: 'medium' },
    );

    assert.deepEqual(updateModel(base, { model: 'claude' }).models.execution, {
      providerId: 'openai',
      model: 'claude',
      effort: 'high',
    });

    // A model that lists no effort carries none, so no reasoning block is sent.
    assert.deepEqual(
      updateModel(base, { model: 'gpt-5-mini' }).models.execution,
      { providerId: 'openai', model: 'gpt-5-mini' },
    );
  });
});

describe('provider transitions', () => {
  test('appends the provider the page filled in', () => {
    const next = addProvider(configuration(), provider('anthropic'));

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['openai', 'anthropic'],
    );
    assert.equal(next.models.execution.providerId, 'openai');
  });

  test('patches only the addressed row', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });
    const next = updateProvider(base, 1, {
      configuration: {
        ...base.providers[1].configuration,
        endpoint: 'https://proxy.internal',
      },
    });

    assert.equal(
      next.providers[0].configuration.endpoint,
      'https://api.example.com',
    );
    assert.equal(
      next.providers[1].configuration.endpoint,
      'https://proxy.internal',
    );
    assert.equal(next.providers[1].id, 'anthropic');
  });

  test('leaves the configuration alone when the row does not exist', () => {
    const base = configuration();

    assert.deepEqual(updateProvider(base, 3, { id: 'azure' }), base);
  });

  test('carries the execution reference along when its provider is renamed', () => {
    const next = updateProvider(configuration(), 0, { id: 'azure' });

    assert.equal(next.providers[0].id, 'azure');
    assert.equal(next.models.execution.providerId, 'azure');
  });

  test('leaves the execution reference alone when another row is renamed', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });
    const next = updateProvider(base, 1, { id: 'azure' });

    assert.equal(next.models.execution.providerId, 'openai');
  });

  test('replaces every field of one row, and no other row', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });
    const next = replaceProvider(base, 0, provider('azure'));

    assert.deepEqual(next.providers[0], provider('azure'));
    assert.deepEqual(next.providers[1], provider('anthropic'));
  });

  test('carries the execution reference along when a replaced row is renamed', () => {
    const next = replaceProvider(configuration(), 0, provider('azure'));

    assert.equal(next.providers[0].id, 'azure');
    assert.equal(next.models.execution.providerId, 'azure');
  });

  test('leaves the configuration alone when no row is at that position', () => {
    const base = configuration();

    assert.deepEqual(replaceProvider(base, 3, provider('azure')), base);
  });

  test('removes a row the execution model does not name', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
      models: {
        execution: {
          providerId: 'anthropic',
          model: 'gpt-5',
          effort: 'medium',
        },
      },
    });
    const next = removeProvider(base, 0);

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['anthropic'],
    );
    assert.equal(next.models.execution.providerId, 'anthropic');
  });

  test('removes one of two rows that share an empty id', () => {
    const base = configuration({
      providers: [provider('openai'), provider(''), provider('')],
    });
    const next = removeProvider(base, 2);

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['openai', ''],
    );
  });

  test('leaves the configuration alone when no row is at that position', () => {
    const base = configuration();

    assert.deepEqual(removeProvider(base, 3), base);
  });

  test('repoints the execution model at the first row left when its own is removed', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });
    const next = removeProvider(base, 0);

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['anthropic'],
    );
    assert.equal(next.models.execution.providerId, 'anthropic');
    assert.equal(configurationIssue(next, kinds), undefined);
  });

  test('points the execution model at nothing when no provider is left', () => {
    const next = removeProvider(configuration(), 0);

    assert.deepEqual(next.providers, []);
    assert.equal(next.models.execution.providerId, '');
    assert.equal(next.execution.maxTurns, 8);
  });
});

describe('provider rows', () => {
  test('gives each provider the place it holds in the list, and its kind', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });

    const rows = providerRows(base, kinds);

    assert.deepEqual(
      rows.map(({ index }) => index),
      [0, 1, 2],
    );
    assert.deepEqual(
      rows.map(({ provider: row }) => row.id),
      ['openai', 'anthropic', 'azure'],
    );
    assert.deepEqual(
      rows.map(({ kind }) => kind?.label),
      ['OpenAI', 'OpenAI', 'OpenAI'],
    );
  });

  test('draws no row for a list holding no providers', () => {
    assert.deepEqual(providerRows(configuration({ providers: [] }), kinds), []);
  });

  test('carries no kind for one the catalog does not declare', () => {
    const rows = providerRows(
      configuration({
        providers: [{ ...provider('openai'), kind: 'mystery' }],
      }),
      kinds,
    );

    assert.equal(rows[0].kind, undefined);
  });

  test('addresses the provider a row names, not the place the table drew it', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });
    // A descending sort draws the last provider first, so the first row on
    // screen is the last provider in the list.
    const drawn = [...providerRows(base, kinds)].reverse();

    const next = updateProvider(base, drawn[0].index, {
      configuration: {
        ...drawn[0].provider.configuration,
        endpoint: 'https://azure.internal',
      },
    });

    assert.equal(
      next.providers[2].configuration.endpoint,
      'https://azure.internal',
    );
    assert.equal(
      next.providers[0].configuration.endpoint,
      'https://api.example.com',
    );
  });

  test('removes the provider a row names when the rows are drawn out of order', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });
    const drawn = [...providerRows(base, kinds)].reverse();

    const next = removeProvider(base, drawn[0].index);

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['openai', 'anthropic'],
    );
  });

  test('keeps a filtered row addressed to the provider it names', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });
    const kept = providerRows(base, kinds).filter(
      ({ provider: row }) => row.id !== 'anthropic',
    );

    const next = removeProvider(base, kept[1].index);

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['openai', 'anthropic'],
    );
  });
});

describe('provider drafts', () => {
  /** The credentials the provider page may offer a provider's secret field. */
  const tokens = [credential('openai-credential')];

  test('opens a draft on the provider at the position it was drawn at', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });

    assert.deepEqual(providerDraftOf(base, 1), {
      ...provider('anthropic'),
      index: 1,
    });
  });

  test('opens no draft for a position holding no provider', () => {
    assert.equal(providerDraftOf(configuration(), 3), undefined);
  });

  test('adds a draft that starts empty in exactly one kind', () => {
    assert.deepEqual(emptyProviderDraft(kinds[0]), {
      id: '',
      kind: 'openai',
      configuration: {
        endpoint: '',
        token: '',
        region: '',
        weight: '',
        note: '',
      },
      models: [],
    });
    // A kind that keeps no models carries none, and only its own fields.
    assert.deepEqual(emptyProviderDraft(kinds[1]), {
      id: '',
      kind: 'ollama',
      configuration: { endpoint: '' },
    });
  });

  test('accepts a draft the host would accept', () => {
    assert.equal(
      providerIssue(provider('openai'), kinds[0], tokens),
      undefined,
    );
  });

  test('refuses an unnamed or overlong id', () => {
    assert.equal(
      providerIssue({ ...provider('openai'), id: '  ' }, kinds[0], tokens),
      'Enter an id between 1 and 128 characters for every provider.',
    );
    assert.equal(
      providerIssue(
        { ...provider('openai'), id: 'p'.repeat(129) },
        kinds[0],
        tokens,
      ),
      'Enter an id between 1 and 128 characters for every provider.',
    );
  });

  test('refuses a field the draft breaks', () => {
    assert.equal(
      providerIssue(
        withField(provider('openai'), 'endpoint', 'api.example.com'),
        kinds[0],
        tokens,
      ),
      'Enter an http:// or https:// address for Endpoint on openai.',
    );
  });

  test('refuses a secret that names no stored API token', () => {
    assert.equal(
      providerIssue(
        withField(provider('openai'), 'token', 'deleted-credential'),
        kinds[0],
        tokens,
      ),
      'Choose the API token openai authenticates with.',
    );
  });

  test('refuses a model the kind rule breaks', () => {
    assert.equal(
      providerIssue(
        {
          ...provider('openai'),
          models: [{ name: 'gpt-5', reasonings: [] }, { name: '' }],
        },
        kinds[0],
        tokens,
      ),
      'Every model must be named for openai.',
    );
  });

  test('carries a required value and leaves an unset optional one out', () => {
    const draft: ProviderDraft = {
      ...emptyProviderDraft(kinds[0]),
      id: 'openai',
      configuration: {
        ...emptyProviderDraft(kinds[0]).configuration,
        endpoint: 'https://api.example.com',
        token: 'openai-credential',
      },
    };

    // `region`, `weight` and `note` were never given a value, so a stored
    // provider carries none of them; the model list its kind keeps is carried
    // empty until entries are added.
    assert.deepEqual(providerFromDraft(draft, kinds[0]), {
      id: 'openai',
      kind: 'openai',
      configuration: {
        endpoint: 'https://api.example.com',
        token: 'openai-credential',
      },
      models: [],
    });
  });

  test('keeps a required value the draft left empty, so the host names it', () => {
    const draft: ProviderDraft = {
      ...emptyProviderDraft(kinds[0]),
      id: 'openai',
    };

    assert.deepEqual(providerFromDraft(draft, kinds[0]).configuration, {
      endpoint: '',
      token: '',
    });
  });

  test('carries the fields of a kind that keeps no models', () => {
    const draft: ProviderDraft = {
      ...emptyProviderDraft(kinds[1]),
      id: 'local',
      configuration: { endpoint: 'http://127.0.0.1:11434' },
    };

    assert.deepEqual(providerFromDraft(draft, kinds[1]), {
      id: 'local',
      kind: 'ollama',
      configuration: { endpoint: 'http://127.0.0.1:11434' },
    });
  });
});

describe('applying a provider draft', () => {
  /** The credentials a provider's secret field may name. */
  const tokens = [credential('openai-credential')];

  test('appends a valid new draft and names the position it took', () => {
    const base = configuration({ providers: [provider('openai')] });
    const draft: ProviderDraft = {
      ...emptyProviderDraft(kinds[1]),
      id: 'local',
      configuration: { endpoint: 'http://127.0.0.1:11434' },
    };

    const applied = applyProviderDraft(base, draft, kinds[1], tokens);

    assert.equal(applied?.draft.index, 1);
    assert.deepEqual(
      applied?.configuration.providers[1],
      providerFromDraft(draft, kinds[1]),
    );
  });

  test('replaces the provider at the position the draft was opened at', () => {
    const base = configuration({
      providers: [provider('openai'), provider('local', kinds[1])],
    });
    const renamed: ProviderDraft = {
      ...provider('openai'),
      index: 0,
      id: 'renamed',
    };

    const applied = applyProviderDraft(base, renamed, kinds[0], tokens);

    assert.deepEqual(applied?.configuration.providers, [
      providerFromDraft(renamed, kinds[0]),
      provider('local', kinds[1]),
    ]);
    // An edited provider keeps the position it was opened at, so a later edit
    // replaces that row rather than appending it again.
    assert.equal(applied?.draft.index, 0);
  });

  test('leaves the configuration alone for a draft the host would refuse', () => {
    const base = configuration();
    const unnamed: ProviderDraft = { ...provider('openai'), id: '  ' };

    assert.equal(
      applyProviderDraft(base, unnamed, kinds[0], tokens),
      undefined,
    );
  });
});

describe('settings vocabulary', () => {
  test('finds the kind the catalog declares under an id', () => {
    assert.equal(kindOf(kinds, 'openai')?.label, 'OpenAI');
    assert.equal(kindOf(kinds, 'mystery'), undefined);
  });

  test('reads a provider address from the field its kind calls an address', () => {
    assert.equal(
      providerAddress(kinds[0], provider('openai')),
      'https://api.example.com',
    );
    // An unknown kind, and an address field left empty, are each drawn as none.
    assert.equal(providerAddress(undefined, provider('openai')), '—');
    assert.equal(
      providerAddress(
        kinds[0],
        withField(provider('openai'), 'endpoint', '  '),
      ),
      '—',
    );
    // A kind that declares no `url` field has no address to read at all.
    const tokenOnly: ProviderKind = {
      id: 'token-only',
      label: 'Token only',
      description: 'No endpoint.',
      fields: [
        { key: 'token', label: 'Token', kind: 'secret', required: true },
      ],
      lists: [],
    };
    assert.equal(providerAddress(tokenOnly, provider('openai')), '—');
  });

  test('names a provider by its id, or by its place until it has one', () => {
    assert.equal(providerLabel(provider('openai'), 0), 'openai');
    assert.equal(providerLabel(provider(''), 1), 'Provider 2');
  });

  test('names every reasoning effort', () => {
    assert.deepEqual(reasoningEfforts.map(effortLabel), [
      'None',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Xhigh',
      'Max',
    ]);
  });

  test('reads a turn limit from a field, and nothing from an empty one', () => {
    assert.equal(turnsFromInput(' 8 '), 8);
    assert.equal(turnsFromInput(''), Number.NaN);
    assert.equal(turnsFromInput('   '), Number.NaN);
    assert.equal(turnsFromInput('eight'), Number.NaN);
  });

  test('shows when the host last stored the configuration', () => {
    assert.equal(updatedAtLabel('not a date'), 'not a date');
    assert.match(updatedAtLabel('2026-09-24T17:09:16.000Z'), /2026/);
  });
});
