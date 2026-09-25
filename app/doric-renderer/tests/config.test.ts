import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  addProvider,
  type Configuration,
  configurationInput,
  configurationIssue,
  effortLabel,
  type GitHubConfiguration,
  type GitHubInput,
  isSameConfiguration,
  type ProviderConfiguration,
  providerLabel,
  type ReasoningEffort,
  reasoningEfforts,
  removeProvider,
  storedTokenNotice,
  tokenFieldText,
  turnsFromInput,
  updatedAtLabel,
  updateGitHub,
  updateModel,
  updateProvider,
  updateTurnLimit,
} from '../src/domain/config';

const provider = (id: string): ProviderConfiguration => ({
  id,
  baseUrl: 'https://api.example.com',
  apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
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

/** A GitHub block the host would accept, which each case then breaks once. */
const gitHub = (
  overrides: Partial<GitHubConfiguration> = {},
): GitHubConfiguration => ({
  username: 'octocat',
  email: 'octocat@example.com',
  hasToken: false,
  ...overrides,
});

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
              apiKeyEnv: 'OPENAI_API_KEY',
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

  test('requires an API-key environment variable name', () => {
    for (const apiKeyEnv of ['openai', 'OPENAI_KEY', 'openai_api_key']) {
      assert.equal(
        configurationIssue(
          withProviders(configuration(), [
            { ...provider('openai'), apiKeyEnv },
          ]),
        ),
        'Enter the API-key environment variable for openai, like OPENAI_API_KEY.',
      );
    }
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

describe('GitHub credential rules', () => {
  test('accepts a configuration that configures no GitHub credentials', () => {
    assert.equal(configurationIssue(configuration()), undefined);
  });

  test('accepts credentials the host would accept', () => {
    assert.equal(
      configurationIssue(configuration({ github: gitHub() })),
      undefined,
    );
  });

  test('accepts an empty block as no credentials, so nothing has to be filled in', () => {
    const empty = configuration({
      github: { username: ' ', email: '', hasToken: false },
    });

    assert.equal(configurationIssue(empty), undefined);
  });

  test('accepts a username, an email and a token at the host bounds', () => {
    const github = gitHub({
      username: 'u'.repeat(128),
      email: `${'e'.repeat(242)}@example.com`,
      token: 't'.repeat(512),
    });

    assert.equal(configurationIssue(configuration({ github })), undefined);
  });

  test('requires a username once the section holds anything', () => {
    for (const username of ['', '   ', 'u'.repeat(129)]) {
      assert.equal(
        configurationIssue(configuration({ github: gitHub({ username }) })),
        'Enter a GitHub username between 1 and 128 characters.',
      );
    }
  });

  test('requires an email address', () => {
    for (const email of [
      '',
      '   ',
      'octocat',
      'octocat@example',
      'octo cat@example.com',
      `${'e'.repeat(243)}@example.com`,
    ]) {
      assert.equal(
        configurationIssue(configuration({ github: gitHub({ email }) })),
        'Enter a GitHub email address.',
      );
    }
  });

  test('asks for the identity a token belongs to', () => {
    const tokenOnly = configuration({
      github: { username: '', email: '', hasToken: false, token: 'ghp_typed' },
    });

    assert.equal(
      configurationIssue(tokenOnly),
      'Enter a GitHub username between 1 and 128 characters.',
    );
  });

  test('refuses a token carrying whitespace rather than trimming it', () => {
    for (const token of [
      'ghp_secret\n',
      'ghp secret',
      ' ghp_secret',
      'ghp_secret\t',
    ]) {
      assert.equal(
        configurationIssue(configuration({ github: gitHub({ token }) })),
        'Enter a GitHub token with no spaces or line breaks, or leave the field empty.',
      );
    }
  });

  test('refuses a token past the host bound', () => {
    assert.equal(
      configurationIssue(
        configuration({ github: gitHub({ token: 't'.repeat(513) }) }),
      ),
      'Enter a GitHub token of at most 512 characters.',
    );
  });
});

describe('GitHub credential transitions', () => {
  test('names the token field as empty until someone types in it', () => {
    assert.equal(tokenFieldText(undefined), '');
    assert.equal(tokenFieldText(gitHub()), '');
    assert.equal(tokenFieldText(gitHub({ hasToken: true })), '');
    assert.equal(
      tokenFieldText(gitHub({ hasToken: true, token: 'ghp_typed' })),
      'ghp_typed',
    );
  });

  test('says whether the host already holds a token', () => {
    assert.equal(
      storedTokenNotice(gitHub({ hasToken: true })),
      'A token is stored; leave this field empty to keep it.',
    );
    assert.equal(storedTokenNotice(gitHub()), 'No token is stored yet.');
    assert.equal(storedTokenNotice(undefined), 'No token is stored yet.');
  });

  test('creates the block on the first field and patches only what it is given', () => {
    const created = updateGitHub(configuration(), { username: 'octocat' });
    assert.deepEqual(created.github, {
      username: 'octocat',
      email: '',
      hasToken: false,
    });

    const patched = updateGitHub(created, { token: 'ghp_typed' });
    assert.deepEqual(patched.github, {
      username: 'octocat',
      email: '',
      hasToken: false,
      token: 'ghp_typed',
    });
  });

  test('keeps a stored token, and what the field says about it, while a field is typed in', () => {
    const base = configuration({ github: gitHub({ hasToken: true }) });
    const next = updateGitHub(base, { email: 'other@example.com' });

    assert.equal(next.github?.hasToken, true);
    assert.equal(tokenFieldText(next.github), '');
    assert.equal(
      storedTokenNotice(next.github),
      'A token is stored; leave this field empty to keep it.',
    );
  });

  test('sends a kept token as null and a typed token as itself', () => {
    const kept = configurationInput(
      configuration({ github: gitHub({ hasToken: true }) }),
    );
    const stored: GitHubInput = {
      username: 'octocat',
      email: 'octocat@example.com',
      token: null,
    };
    assert.deepEqual(kept.github, stored);

    const typed = configurationInput(
      configuration({ github: gitHub({ token: 'ghp_typed' }) }),
    );
    assert.deepEqual(typed.github, { ...stored, token: 'ghp_typed' });
  });

  test('sends the rest of the configuration as the draft holds it', () => {
    const input = configurationInput(
      configuration({ github: gitHub({ token: 'ghp_typed' }) }),
    );

    assert.deepEqual(input.providers, configuration().providers);
    assert.equal(input.models.execution.providerId, 'openai');
    assert.equal(input.models.execution.model, 'gpt-5');
    assert.equal(input.execution.maxTurns, 8);
  });

  test('removes a block the user emptied, rather than omitting the key', () => {
    // Omission means "leave it alone", so clearing the section has to say so.
    const cleared = configuration({
      github: { username: ' ', email: '', hasToken: true },
    });

    assert.deepEqual(configurationInput(cleared), {
      ...configuration(),
      github: null,
    });
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
      withProviders(base, [
        { ...provider('openai'), apiKeyEnv: 'OTHER_API_KEY' },
      ]),
      updateModel(base, { providerId: 'anthropic' }),
      updateModel(base, { model: 'gpt-5-mini' }),
      updateModel(base, { effort: 'high' }),
      updateTurnLimit(base, 16),
    ];

    for (const candidate of changed) {
      assert.equal(isSameConfiguration(base, candidate), false);
    }
  });

  test('compares the GitHub block, including the token the field holds', () => {
    const base = configuration({ github: gitHub({ hasToken: true }) });

    assert.ok(
      isSameConfiguration(
        base,
        configuration({ github: gitHub({ hasToken: true }) }),
      ),
    );

    const changed: readonly Configuration[] = [
      configuration(),
      configuration({ github: gitHub() }),
      configuration({ github: gitHub({ hasToken: true, username: 'hubot' }) }),
      configuration({
        github: gitHub({ hasToken: true, email: 'other@example.com' }),
      }),
      configuration({ github: gitHub({ hasToken: true, token: 'ghp_typed' }) }),
    ];

    for (const candidate of changed) {
      assert.equal(isSameConfiguration(base, candidate), false);
    }
  });

  test('holds for a cleared GitHub block and no block at all', () => {
    assert.ok(
      isSameConfiguration(
        configuration(),
        configuration({ github: { username: '', email: '', hasToken: false } }),
      ),
    );
  });
});

describe('provider transitions', () => {
  test('appends an unnamed row without disturbing the execution model', () => {
    const next = addProvider(configuration());

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['openai', ''],
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
