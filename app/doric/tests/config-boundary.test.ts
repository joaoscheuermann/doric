import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Configuration,
  workspaceApi,
  WorkspaceError,
} from '../src/workspace/api';
import { configuration, providerValues } from '../src/workspace/validation';

const valid: Configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: '00000000-0000-4000-8000-000000000001',
      },
      models: [
        { name: 'deepseek/deepseek-v4-flash-0731', reasonings: ['low'] },
      ],
    },
    {
      id: 'local',
      kind: 'lmstudio',
      configuration: {},
      models: [{ name: 'local-model' }],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
};

const snapshot = {
  configuration: valid,
  revision: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const invalidConfiguration = (error: unknown) =>
  error instanceof WorkspaceError &&
  error.message === 'The configuration is invalid.';

const invalidResponse = (error: unknown) =>
  error instanceof WorkspaceError &&
  error.message === 'Doric returned an invalid response.';

const provider = (overrides: Record<string, unknown>) => ({
  ...valid.providers[0],
  ...overrides,
});

const execution = (overrides: Record<string, unknown>) => ({
  ...valid,
  models: { execution: { ...valid.models.execution, ...overrides } },
});

const turns = (maxTurns: unknown) => ({
  ...valid,
  execution: { maxTurns },
});

/** A configuration naming both credential choices, which cases then break once. */
const withChoices = (overrides: Record<string, unknown>) => ({
  ...valid,
  ...overrides,
});

describe('Configuration validation', () => {
  test('forwards a valid configuration as a new object holding only its known keys', () => {
    const rendered = {
      ...structuredClone(valid),
      rendererOnlyState: 'draft',
      models: {
        execution: { ...valid.models.execution, draft: true },
      },
    };

    const forwarded = configuration(rendered);

    assert.deepEqual(forwarded, valid);
    assert.notEqual(forwarded, rendered);
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['a primitive', 'configuration'],
    ['a number', 7],
    ['an array', [valid]],
    ['a missing providers list', { ...valid, providers: undefined }],
    ['providers as an object', { ...valid, providers: valid.providers[0] }],
    ['a null provider', { ...valid, providers: [null] }],
    ['a provider missing its kind', provider({ kind: undefined })],
    ['an empty provider kind', provider({ kind: '' })],
    [
      'a provider kind over 128 characters',
      provider({ kind: 'a'.repeat(129) }),
    ],
    [
      'a provider missing its configuration',
      provider({ configuration: undefined }),
    ],
    [
      'a configuration that is not a record',
      provider({ configuration: 'none' }),
    ],
    ['a configuration that is a list', provider({ configuration: [] })],
    [
      'a configuration value that is not a string',
      provider({ configuration: { token: 7 } }),
    ],
    [
      'a configuration value that is empty',
      provider({ configuration: { token: '' } }),
    ],
    ['an empty provider id', provider({ id: '' })],
    ['a whitespace-only provider id', provider({ id: '   ' })],
    ['a provider id over 128 characters', provider({ id: 'a'.repeat(129) })],
    ['models that are not a list', provider({ models: 'a-model' })],
    ['a model that is not a record', provider({ models: [7] })],
    ['a model missing its name', provider({ models: [{}] })],
    ['a model with an empty name', provider({ models: [{ name: '' }] })],
    [
      'a model over 512 characters',
      provider({ models: [{ name: 'a'.repeat(513) }] }),
    ],
    [
      'model reasonings that are not a list',
      provider({ models: [{ name: 'a-model', reasonings: 'low' }] }),
    ],
    [
      'a model reasoning that is not a string',
      provider({ models: [{ name: 'a-model', reasonings: [7] }] }),
    ],
    [
      'a model reasoning outside the closed set',
      provider({ models: [{ name: 'a-model', reasonings: ['extreme'] }] }),
    ],
    ['a missing models section', { ...valid, models: undefined }],
    ['models as an array', { ...valid, models: [] }],
    ['missing execution models', { ...valid, models: {} }],
    ['an unknown reasoning effort', execution({ effort: 'extreme' })],
    ['a non-string reasoning effort', execution({ effort: 3 })],
    ['an empty execution model', execution({ model: '' })],
    [
      'an execution model over 512 characters',
      execution({ model: 'a'.repeat(513) }),
    ],
    ['an empty execution provider id', execution({ providerId: '' })],
    ['a missing execution section', { ...valid, execution: undefined }],
    ['a fractional maxTurns', turns(1.5)],
    ['a zero maxTurns', turns(0)],
    ['a negative maxTurns', turns(-4)],
    ['a string maxTurns', turns('32')],
    ['an unsafe integer maxTurns', turns(Number.MAX_SAFE_INTEGER + 1)],
  ];

  for (const [scenario, value] of malformed) {
    test(`rejects ${scenario}`, () => {
      assert.throws(() => configuration(value), invalidConfiguration);
    });
  }

  test('accepts an execution profile whose model lists no reasoning effort', () => {
    const configured = configuration({
      ...structuredClone(valid),
      models: { execution: { providerId: 'openrouter', model: 'mimo' } },
    });

    assert.deepEqual(configured.models.execution, {
      providerId: 'openrouter',
      model: 'mimo',
    });
  });
});

describe('the provider catalog boundary', () => {
  const values = {
    kind: 'openrouter',
    configuration: { token: '00000000-0000-4000-8000-000000000002' },
  };

  test('forwards the values a catalog read names, and nothing else', () => {
    const rendered = { ...structuredClone(values), models: [], draft: true };

    const forwarded = providerValues(rendered);

    assert.deepEqual(forwarded, values);
    assert.notEqual(forwarded, rendered);
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['a primitive', 'openrouter'],
    ['a number', 7],
    ['a missing kind', { configuration: {} }],
    ['an empty kind', { kind: '', configuration: {} }],
    ['a kind over the identifier bound', { kind: 'k'.repeat(129) }],
    ['a missing configuration', { kind: 'openrouter' }],
    ['a configuration that is a list', { ...values, configuration: [] }],
    [
      'a value that is not a string',
      { ...values, configuration: { token: 7 } },
    ],
    ['an empty value', { ...values, configuration: { token: '' } }],
    [
      'a value over the field bound',
      { ...values, configuration: { token: 't'.repeat(513) } },
    ],
  ];

  for (const [scenario, value] of malformed) {
    test(`refuses ${scenario}`, () => {
      assert.throws(() => providerValues(value), invalidConfiguration);
    });
  }
});

describe('the model catalog boundary', () => {
  const answer = async (body: unknown) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(body);
    try {
      return await workspaceApi.providers.models({
        kind: 'openrouter',
        configuration: { token: '00000000-0000-4000-8000-000000000002' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('reads the models the endpoint described', async () => {
    const models = await answer({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-5',
          parameters: ['tools', 'tool_choice'],
          reasonings: ['high', 'medium'],
        },
        { id: 'local/model', parameters: [], reasonings: [] },
      ],
    });

    assert.deepEqual(models, [
      {
        id: 'openai/gpt-5',
        name: 'OpenAI: GPT-5',
        parameters: ['tools', 'tool_choice'],
        reasonings: ['high', 'medium'],
      },
      { id: 'local/model', parameters: [], reasonings: [] },
    ]);
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['an envelope that is not an object', []],
    ['a missing models list', {}],
    ['models that are not a list', { models: 'a-model' }],
    ['a model that is not an object', { models: [7] }],
    ['a model without an id', { models: [{ parameters: [], reasonings: [] }] }],
    [
      'a model without its parameters',
      { models: [{ id: 'a/model', reasonings: [] }] },
    ],
    [
      'a model without its reasonings',
      { models: [{ id: 'a/model', parameters: [] }] },
    ],
    [
      'a model naming an effort the host does not know',
      { models: [{ id: 'a/model', parameters: [], reasonings: ['extreme'] }] },
    ],
    [
      'a model naming a name that is not a string',
      { models: [{ id: 'a/model', name: 7, parameters: [], reasonings: [] }] },
    ],
  ];

  for (const [scenario, value] of malformed) {
    test(`refuses ${scenario}`, async () => {
      await assert.rejects(answer(value), invalidResponse);
    });
  }
});

describe('credential choice boundary', () => {
  test('accepts a configuration that names both choices', () => {
    const named = withChoices({
      gitCredentialId: '00000000-0000-4000-8000-000000000010',
      githubCredentialId: '00000000-0000-4000-8000-000000000011',
    });

    assert.deepEqual(configuration(named), named);
  });

  test('treats an absent choice as none configured', () => {
    assert.equal('gitCredentialId' in configuration(valid), false);
    assert.equal('githubCredentialId' in configuration(valid), false);
  });

  test('reads an empty or null choice as none, because neither is a reference', () => {
    assert.equal(
      'gitCredentialId' in configuration(withChoices({ gitCredentialId: '' })),
      false,
    );
    assert.equal(
      'githubCredentialId' in
        configuration(withChoices({ githubCredentialId: null })),
      false,
    );
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a numeric choice', withChoices({ gitCredentialId: 7 })],
    ['an object choice', withChoices({ githubCredentialId: { id: 'x' } })],
    [
      'a choice over the identifier bound',
      withChoices({ gitCredentialId: 'a'.repeat(129) }),
    ],
    [
      'a choice carrying a NUL byte',
      withChoices({ gitCredentialId: 'a\u0000b' }),
    ],
  ];

  for (const [scenario, value] of malformed) {
    test(`rejects ${scenario}`, () => {
      assert.throws(() => configuration(value), invalidConfiguration);
    });
  }
});

describe('configuration response boundary', () => {
  const answer = async (body: unknown) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(body);
    try {
      return await workspaceApi.config.get();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('reads back an execution profile whose model lists no reasoning effort', async () => {
    const stored = await answer({
      configuration: {
        ...structuredClone(valid),
        models: { execution: { providerId: 'openrouter', model: 'mimo' } },
      },
      revision: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.deepEqual(stored.configuration.models.execution, {
      providerId: 'openrouter',
      model: 'mimo',
    });
  });

  test('drops an unknown reasoning effort rather than reading it', async () => {
    await assert.rejects(
      answer({
        ...structuredClone(snapshot),
        configuration: {
          ...structuredClone(valid),
          models: {
            execution: { ...valid.models.execution, effort: 'extreme' },
          },
        },
      }),
      invalidResponse,
    );
  });
});

describe('credential response boundary', () => {
  const answer = async (body: unknown) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(body);
    try {
      return await workspaceApi.credentials.list();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('reads a credential without ever carrying a secret', async () => {
    const listed = await answer([
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'API_TOKEN',
        name: 'openrouter',
        hasSecret: true,
      },
    ]);

    assert.deepEqual(listed, [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'API_TOKEN',
        name: 'openrouter',
        hasSecret: true,
      },
    ]);
  });

  test('drops a secret a host answered with, so it can never be rendered back', async () => {
    const listed = await answer([
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'API_TOKEN',
        name: 'openrouter',
        hasSecret: true,
        secret: 'sk_leaked',
      },
    ]);

    assert.equal('secret' in (listed[0] ?? {}), false);
    assert.equal(JSON.stringify(listed).includes('sk_leaked'), false);
  });

  test('refuses a credential whose kind is outside the closed set', async () => {
    await assert.rejects(
      answer([
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'CERTIFICATE',
          name: 'openrouter',
          hasSecret: true,
        },
      ]),
      invalidResponse,
    );
  });

  test('refuses a credential missing the flag that stands in for its secret', async () => {
    await assert.rejects(
      answer([
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'API_TOKEN',
          name: 'openrouter',
        },
      ]),
      invalidResponse,
    );
  });

  test('refuses a list that is not an array', async () => {
    await assert.rejects(answer({ items: [] }), invalidResponse);
  });
});

describe('Configuration HTTP boundary', () => {
  test('reads and replaces the host configuration through the config route', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(snapshot);
    };

    try {
      assert.deepEqual(await workspaceApi.config.get(), snapshot);
      assert.deepEqual(await workspaceApi.config.update(valid), snapshot);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0]?.url, 'http://127.0.0.1:3000/config');
    assert.equal(requests[0]?.init?.method, undefined);
    assert.equal(requests[1]?.url, 'http://127.0.0.1:3000/config');
    assert.equal(requests[1]?.init?.method, 'PUT');
    assert.equal(requests[1]?.init?.body, JSON.stringify(valid));
  });

  test('reads the credential choices a host answered with', async () => {
    const originalFetch = globalThis.fetch;
    const choices = {
      gitCredentialId: '00000000-0000-4000-8000-000000000010',
      githubCredentialId: '00000000-0000-4000-8000-000000000011',
    };
    globalThis.fetch = async () =>
      Response.json({ ...snapshot, configuration: { ...valid, ...choices } });

    try {
      const read = await workspaceApi.config.get();
      assert.deepEqual(read.configuration, { ...valid, ...choices });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses a choice that is null, which is not a reference the host sends', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        ...snapshot,
        configuration: { ...valid, gitCredentialId: null },
      });

    try {
      await assert.rejects(workspaceApi.config.get(), invalidResponse);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const malformedResponses: ReadonlyArray<readonly [string, unknown]> = [
    ['a snapshot without a revision number', { ...snapshot, revision: '3' }],
    [
      'a snapshot without an execution section',
      {
        configuration: { providers: valid.providers, models: valid.models },
        revision: 3,
        updatedAt: snapshot.updatedAt,
      },
    ],
    [
      'a configuration without a maxTurns number',
      {
        ...snapshot,
        configuration: { ...valid, execution: { maxTurns: '32' } },
      },
    ],
    [
      'a configuration holding a malformed provider',
      { ...snapshot, configuration: { ...valid, providers: [null] } },
    ],
    [
      'a configuration whose provider names no kind',
      {
        ...snapshot,
        configuration: {
          ...valid,
          providers: [{ id: 'openrouter', configuration: {} }],
        },
      },
    ],
    [
      'a configuration whose provider values are not strings',
      {
        ...snapshot,
        configuration: {
          ...valid,
          providers: [
            {
              id: 'openrouter',
              kind: 'openrouter',
              configuration: { token: 7 },
            },
          ],
        },
      },
    ],
    [
      'a configuration whose model carries a reasoning llms does not know',
      {
        ...snapshot,
        configuration: {
          ...valid,
          providers: [
            {
              ...valid.providers[0],
              models: [
                {
                  name: 'deepseek/deepseek-v4-flash-0731',
                  reasonings: ['extreme'],
                },
              ],
            },
          ],
        },
      },
    ],
    [
      'a configuration whose credential choice is not a string',
      {
        ...snapshot,
        configuration: { ...valid, githubCredentialId: { id: 'x' } },
      },
    ],
  ];

  for (const [scenario, body] of malformedResponses) {
    test(`rejects ${scenario}`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => Response.json(body);

      try {
        await assert.rejects(workspaceApi.config.get(), invalidResponse);
        await assert.rejects(
          workspaceApi.config.update(valid),
          invalidResponse,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test('surfaces the host message when the configuration is rejected', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        {
          error: {
            code: 'invalid_config',
            message: 'The Doric configuration is invalid.',
          },
        },
        { status: 422 },
      );

    try {
      await assert.rejects(
        workspaceApi.config.update(valid),
        (error) =>
          error instanceof WorkspaceError &&
          error.message === 'The Doric configuration is invalid.' &&
          error.status === 422,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Provider catalog boundary', () => {
  const kinds = [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      description: 'OpenRouter.',
      fields: [
        {
          key: 'endpoint',
          label: 'Endpoint',
          kind: 'url',
          required: false,
          description: 'Overrides the base URL.',
          placeholder: 'https://openrouter.ai/api/v1',
        },
        { key: 'token', label: 'Token', kind: 'secret', required: true },
      ],
      lists: ['models', 'reasonings'],
    },
    {
      id: 'codex',
      label: 'Codex',
      description: 'Codex.',
      fields: [
        {
          key: 'fedramp',
          label: 'FedRAMP',
          kind: 'enum',
          required: false,
          placeholder: 'false',
          options: ['true', 'false'],
        },
      ],
      lists: [],
    },
  ];

  const answer = async (body: unknown) => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return Response.json(body);
    };

    try {
      return { kinds: await workspaceApi.providers.kinds(), requests };
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('unwraps the catalog a host answered with', async () => {
    const read = await answer({ kinds });

    assert.deepEqual(read.kinds, kinds);
    assert.deepEqual(read.requests, ['http://127.0.0.1:3000/providers/kinds']);
  });

  /** The token field of the first kind, which each malformed case breaks once. */
  const field = () => kinds[0]!.fields[1]!;

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a body with no kinds envelope', []],
    ['a kinds envelope that is not a list', { kinds: {} }],
    ['a kind with no label', { kinds: [{ ...kinds[0], label: undefined }] }],
    [
      'a kind with no fields list',
      { kinds: [{ ...kinds[0], fields: 'none' }] },
    ],
    [
      'a field whose kind is outside the closed set',
      { kinds: [{ ...kinds[0], fields: [{ ...field(), kind: 'colour' }] }] },
    ],
    [
      'a field with no required flag',
      {
        kinds: [{ ...kinds[0], fields: [{ ...field(), required: undefined }] }],
      },
    ],
    [
      'an enum field with no options',
      { kinds: [{ ...kinds[0], fields: [{ ...field(), kind: 'enum' }] }] },
    ],
    [
      'a text field offering options',
      { kinds: [{ ...kinds[0], fields: [{ ...field(), options: ['a'] }] }] },
    ],
    [
      'a field whose options are not strings',
      {
        kinds: [
          { ...kinds[0], fields: [{ ...field(), kind: 'enum', options: [7] }] },
        ],
      },
    ],
    [
      'a kind keeping a list outside the closed set',
      { kinds: [{ ...kinds[0], lists: ['endpoints'] }] },
    ],
  ];

  for (const [scenario, body] of malformed) {
    test(`refuses ${scenario}`, async () => {
      await assert.rejects(answer(body), invalidResponse);
    });
  }
});
