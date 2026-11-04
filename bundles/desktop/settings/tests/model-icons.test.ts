// What the settings surfaces ask the host about icons, and how they read its
// answers back by provider id: the requests a configuration makes, the
// request for a provider's own icon, and the lookup over an answer.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  Configuration,
  ProviderConfiguration,
} from '../src/client/domain/config.js';
import {
  iconLookupFrom,
  modelIconRequests,
  providerIconRequest,
} from '../src/client/domain/model-icons.js';

const openrouter: ProviderConfiguration = {
  id: 'openrouter',
  kind: 'openrouter',
  configuration: {
    endpoint: 'https://openrouter.ai/api/v1',
    token: '00000000-0000-4000-8000-000000000001',
  },
  models: [{ name: 'anthropic/claude-sonnet-4' }, { name: 'acme/coder-7b' }],
};

const lmstudio: ProviderConfiguration = {
  id: 'lmstudio',
  kind: 'openai',
  configuration: { endpoint: 'http://localhost:1234/v1' },
  models: [{ name: 'llama3' }],
};

const configurationOf = (
  providers: readonly ProviderConfiguration[],
  execution: Configuration['models']['execution'],
): Configuration => ({
  providers,
  models: { execution },
  execution: { maxTurns: 8 },
});

describe('the icons a configuration asks for', () => {
  test('icon requests list each provider in order with its models, and the execution model only under its own provider when unlisted', () => {
    const configuration = configurationOf([openrouter, lmstudio], {
      providerId: 'lmstudio',
      model: 'qwen3',
    });

    assert.deepEqual(modelIconRequests(configuration), [
      {
        providerId: 'openrouter',
        kind: 'openrouter',
        configuration: openrouter.configuration,
        models: ['anthropic/claude-sonnet-4', 'acme/coder-7b'],
      },
      {
        providerId: 'lmstudio',
        kind: 'openai',
        configuration: { endpoint: 'http://localhost:1234/v1' },
        models: ['llama3', 'qwen3'],
      },
    ]);
  });

  test('icon requests leave out names longer than 512 characters and ask for at most 1000', () => {
    const tooLong = 'x'.repeat(513);
    const names = Array.from({ length: 1001 }, (_, index) => `model-${index}`);
    const configuration = configurationOf(
      [
        {
          ...lmstudio,
          models: [tooLong, ...names].map((name) => ({ name })),
        },
      ],
      { providerId: 'lmstudio', model: 'model-0' },
    );

    const [request] = modelIconRequests(configuration);

    assert.deepEqual(request?.models, names.slice(0, 1000));
  });

  test('a provider icon request asks for no model', () => {
    assert.deepEqual(providerIconRequest(openrouter), {
      providerId: 'openrouter',
      kind: 'openrouter',
      configuration: openrouter.configuration,
      models: [],
    });
  });
});

describe('reading the icons an answer holds', () => {
  test("the lookup reads each name's SVG by provider id, and knows nothing of an unknown id or model", () => {
    const openrouterSvg = '<svg id="openrouter"></svg>';
    const claudeSvg = '<svg id="claude"></svg>';
    const lookup = iconLookupFrom(
      [
        {
          providerId: 'openrouter',
          kind: 'openrouter',
          configuration: openrouter.configuration,
          models: ['anthropic/claude-sonnet-4', 'acme/coder-7b'],
        },
        {
          providerId: 'lmstudio',
          kind: 'openai',
          configuration: lmstudio.configuration,
          models: ['llama3'],
        },
      ],
      {
        svgs: { openrouter: openrouterSvg, claude: claudeSvg },
        answers: [
          { provider: 'openrouter', models: ['claude', 'openrouter'] },
          { models: [null] },
        ],
      },
    );

    assert.equal(lookup.provider('openrouter'), openrouterSvg);
    assert.equal(
      lookup.model('openrouter', 'anthropic/claude-sonnet-4'),
      claudeSvg,
    );
    assert.equal(lookup.model('openrouter', 'acme/coder-7b'), openrouterSvg);
    assert.equal(lookup.model('openrouter', 'never-asked'), undefined);
    assert.equal(lookup.provider('lmstudio'), undefined);
    assert.equal(lookup.model('lmstudio', 'llama3'), undefined);
    assert.equal(lookup.provider('unknown'), undefined);
    assert.equal(lookup.model('unknown', 'llama3'), undefined);
  });
});
