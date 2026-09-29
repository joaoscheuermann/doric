import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Configuration,
  workspaceApi,
  WorkspaceError,
} from '../src/workspace/api';
import { configuration } from '../src/workspace/validation';

const valid: Configuration = {
  providers: [
    {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialId: '00000000-0000-4000-8000-000000000001',
    },
    {
      id: 'local',
      baseUrl: 'http://127.0.0.1:1234/v1',
      credentialId: '00000000-0000-4000-8000-000000000002',
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
    ['a provider missing its base URL', provider({ baseUrl: undefined })],
    ['an empty provider id', provider({ id: '' })],
    ['a whitespace-only provider id', provider({ id: '   ' })],
    ['a provider id over 128 characters', provider({ id: 'a'.repeat(129) })],
    ['an empty credential reference', provider({ credentialId: '' })],
    ['a missing credential reference', provider({ credentialId: undefined })],
    ['a non-string credential reference', provider({ credentialId: 7 })],
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

  test('sends a GitHub block, and the token it replaces, through the config route', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(snapshot);
    };

    const input = {
      ...valid,
      github: {
        username: 'octocat',
        email: 'octocat@example.com',
        token: 'ghp_typed',
      },
    };

    try {
      await workspaceApi.config.update(input);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0]?.init?.method, 'PUT');
    assert.equal(requests[0]?.init?.body, JSON.stringify(input));
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
