import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  addProvider,
  type Configuration,
  configurationIssue,
  type Credential,
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
  isSameConfiguration,
  isUsableChoice,
  type ProviderConfiguration,
  providerDraftOf,
  providerIssue,
  providerLabel,
  providerRows,
  type ReasoningEffort,
  reasoningEfforts,
  removeProvider,
  replaceProvider,
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

const provider = (id: string): ProviderConfiguration => ({
  id,
  baseUrl: 'https://api.example.com',
  credentialId: `${id}-credential`,
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
    assert.equal(configurationIssue(configuration()), undefined);
  });

  test("accepts values at the host's own bounds", () => {
    const id = 'p'.repeat(128);
    assert.equal(
      configurationIssue(
        configuration({
          providers: [
            {
              id,
              baseUrl: 'http://localhost:11434',
              credentialId: 'c'.repeat(128),
            },
          ],
          models: {
            execution: {
              providerId: id,
              model: 'm'.repeat(512),
              effort: 'xhigh',
            },
          },
        }),
      ),
      undefined,
    );
  });

  test('requires at least one provider', () => {
    assert.equal(
      configurationIssue(withProviders(configuration(), [])),
      'Add at least one provider.',
    );
  });

  test('requires every provider id to be named and bounded', () => {
    assert.equal(
      configurationIssue(withProviders(configuration(), [provider('  ')])),
      'Enter an id between 1 and 128 characters for every provider.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [provider('p'.repeat(129))]),
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
      ),
      'Provider ids must be unique.',
    );
  });

  test('requires an http or https base URL', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), baseUrl: 'api.example.com' },
        ]),
      ),
      'Enter an http:// or https:// base URL for openai.',
    );
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), baseUrl: 'ftp://api.example.com' },
        ]),
      ),
      'Enter an http:// or https:// base URL for openai.',
    );
  });

  test('requires a credential reference on every provider', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), credentialId: '' },
        ]),
      ),
      'Choose the credential openai authenticates with.',
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
        ),
        'Enter a model between 1 and 512 characters.',
      );
    }
  });

  test('requires one of the six reasoning efforts', () => {
    assert.equal(
      configurationIssue(
        withExecution(configuration(), {
          providerId: 'openai',
          model: 'gpt-5',
          effort: 'extreme' as ReasoningEffort,
        }),
      ),
      'Choose a reasoning effort.',
    );
  });

  test('requires a positive whole turn limit', () => {
    for (const maxTurns of [0, -1, 2.5, Number.NaN]) {
      assert.equal(
        configurationIssue(configuration({ execution: { maxTurns } })),
        'Enter a turn limit of 1 or more.',
      );
    }
  });
});

describe('credential choice rules', () => {
  test('accepts a configuration that names no credentials', () => {
    assert.equal(configurationIssue(configuration()), undefined);
  });

  test('requires a credential for every provider', () => {
    assert.equal(
      configurationIssue(
        withProviders(configuration(), [
          { ...provider('openai'), credentialId: '' },
        ]),
      ),
      'Choose the credential openai authenticates with.',
    );
  });

  test('holds for a configuration that names both choices', () => {
    assert.equal(
      configurationIssue(
        configuration({
          gitCredentialId: 'identity',
          githubCredentialId: 'token',
        }),
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
      withProviders(base, [
        { ...provider('openai'), baseUrl: 'https://other.example.com' },
      ]),
      withProviders(base, [{ ...provider('openai'), credentialId: 'other' }]),
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

describe('provider transitions', () => {
  test('appends the provider the dialog filled in', () => {
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
    const next = updateProvider(base, 1, { baseUrl: 'https://proxy.internal' });

    assert.equal(next.providers[0].baseUrl, 'https://api.example.com');
    assert.equal(next.providers[1].baseUrl, 'https://proxy.internal');
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
    const next = replaceProvider(base, 0, {
      id: 'azure',
      baseUrl: 'https://azure.internal',
      credentialId: 'azure-credential',
    });

    assert.deepEqual(next.providers[0], {
      id: 'azure',
      baseUrl: 'https://azure.internal',
      credentialId: 'azure-credential',
    });
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
    assert.equal(configurationIssue(next), undefined);
  });

  test('points the execution model at nothing when no provider is left', () => {
    const next = removeProvider(configuration(), 0);

    assert.deepEqual(next.providers, []);
    assert.equal(next.models.execution.providerId, '');
    assert.equal(next.execution.maxTurns, 8);
  });
});

describe('provider rows', () => {
  test('gives each provider the place it holds in the list', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });

    assert.deepEqual(
      providerRows(base).map(({ index }) => index),
      [0, 1, 2],
    );
    assert.deepEqual(
      providerRows(base).map(({ provider: row }) => row.id),
      ['openai', 'anthropic', 'azure'],
    );
  });

  test('draws no row for a list holding no providers', () => {
    assert.deepEqual(providerRows(configuration({ providers: [] })), []);
  });

  test('addresses the provider a row names, not the place the table drew it', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });
    // A descending sort draws the last provider first, so the first row on
    // screen is the last provider in the list.
    const drawn = [...providerRows(base)].reverse();

    const next = updateProvider(base, drawn[0].index, {
      baseUrl: 'https://azure.internal',
    });

    assert.equal(next.providers[2].baseUrl, 'https://azure.internal');
    assert.equal(next.providers[0].baseUrl, 'https://api.example.com');
  });

  test('removes the provider a row names when the rows are drawn out of order', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic'), provider('azure')],
    });
    const drawn = [...providerRows(base)].reverse();

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
    const kept = providerRows(base).filter(
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

  test('adds a draft that names no provider until it is filled in', () => {
    assert.deepEqual(emptyProviderDraft(), {
      id: '',
      baseUrl: '',
      credentialId: '',
    });
  });

  test('accepts a draft the host would accept', () => {
    assert.equal(providerIssue(provider('openai')), undefined);
  });

  test('refuses an unnamed or overlong id', () => {
    assert.equal(
      providerIssue({ ...provider('openai'), id: '  ' }),
      'Enter an id between 1 and 128 characters for every provider.',
    );
    assert.equal(
      providerIssue({ ...provider('openai'), id: 'p'.repeat(129) }),
      'Enter an id between 1 and 128 characters for every provider.',
    );
  });

  test('refuses anything but an http base URL', () => {
    assert.equal(
      providerIssue({ ...provider('openai'), baseUrl: 'api.example.com' }),
      'Enter an http:// or https:// base URL for openai.',
    );
  });

  test('refuses a provider that authenticates with nothing', () => {
    assert.equal(
      providerIssue({ ...provider('openai'), credentialId: '' }),
      'Choose the credential openai authenticates with.',
    );
  });
});

describe('settings vocabulary', () => {
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
