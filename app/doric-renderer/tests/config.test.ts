import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  addProvider,
  type Configuration,
  configurationIssue,
  effortLabel,
  isSameConfiguration,
  type ProviderConfiguration,
  providerLabel,
  type ReasoningEffort,
  reasoningEfforts,
  removeProvider,
  turnsFromInput,
  updatedAtLabel,
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
    const next = removeProvider(base, 'openai');

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['anthropic'],
    );
    assert.equal(next.models.execution.providerId, 'anthropic');
  });

  test('repoints the execution model at the first row left when its own is removed', () => {
    const base = configuration({
      providers: [provider('openai'), provider('anthropic')],
    });
    const next = removeProvider(base, 'openai');

    assert.deepEqual(
      next.providers.map(({ id }) => id),
      ['anthropic'],
    );
    assert.equal(next.models.execution.providerId, 'anthropic');
    assert.equal(configurationIssue(next), undefined);
  });

  test('points the execution model at nothing when no provider is left', () => {
    const next = removeProvider(configuration(), 'openai');

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
