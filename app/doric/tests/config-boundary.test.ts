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
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    {
      id: 'local',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKeyEnv: 'LOCAL_API_KEY',
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

/** A GitHub block a save may send, which each case then breaks once. */
const githubBlock = (overrides: Record<string, unknown> = {}) => ({
  username: 'octocat',
  email: 'octocat@example.com',
  token: null,
  ...overrides,
});

const withGitHub = (github: unknown) => ({ ...valid, github });

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
    ['an empty API key environment name', provider({ apiKeyEnv: '' })],
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

describe('GitHub configuration boundary', () => {
  test('accepts a block that names a username and an email', () => {
    assert.deepEqual(
      configuration(withGitHub(githubBlock())).github,
      githubBlock(),
    );
  });

  test('reads an absent token as null, which keeps the stored one', () => {
    const named = { username: 'octocat', email: 'octocat@example.com' };

    assert.deepEqual(configuration(withGitHub(named)).github, githubBlock());
    assert.deepEqual(
      configuration(withGitHub({ ...named, token: undefined })).github,
      githubBlock(),
    );
  });

  test('passes an empty token through, which clears the stored one', () => {
    assert.deepEqual(
      configuration(withGitHub(githubBlock({ token: '' }))).github,
      githubBlock({ token: '' }),
    );
  });

  test('passes a replacement token through unchanged', () => {
    const token = 'ghp_example1234567890';

    assert.equal(
      configuration(withGitHub(githubBlock({ token }))).github?.token,
      token,
    );
  });

  test('treats an absent block as none configured', () => {
    assert.equal('github' in configuration(valid), false);
    assert.equal('github' in configuration(withGitHub(undefined)), false);
  });

  test('passes an explicit null through as the removal instruction', () => {
    // Absent leaves the stored block alone, so removal has its own spelling.
    assert.deepEqual(configuration({ ...valid, github: null }), {
      ...configuration(valid),
      github: null,
    });
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a GitHub block that is not an object', withGitHub('github')],
    ['an unknown key inside it', githubBlock({ password: 'hunter2' })],
    ['a missing username', { email: 'octocat@example.com' }],
    ['a blank username', githubBlock({ username: '   ' })],
    [
      'a username over 128 characters',
      githubBlock({ username: 'u'.repeat(129) }),
    ],
    ['a missing email', { username: 'octocat' }],
    ['a blank email', githubBlock({ email: '   ' })],
    ['an email that is not an address', githubBlock({ email: 'octocat' })],
    [
      'an email over 254 characters',
      githubBlock({ email: `${'e'.repeat(243)}@example.com` }),
    ],
    ['a token carrying a newline', githubBlock({ token: 'ghp_secret\n' })],
    ['a token carrying a space', githubBlock({ token: 'ghp secret' })],
    ['a token over 512 characters', githubBlock({ token: 't'.repeat(513) })],
    ['a token that is not text', githubBlock({ token: 42 })],
    ['a token that is an object', githubBlock({ token: { value: 'ghp' } })],
  ];

  for (const [scenario, value] of malformed) {
    test(`rejects ${scenario}`, () => {
      assert.throws(() => configuration(value), invalidConfiguration);
    });
  }

  test('never names the token it refused', () => {
    const secret = 'ghp_do_not_echo_me';
    const refused = [
      githubBlock({ token: `${secret}\n` }),
      githubBlock({ token: secret.repeat(50) }),
      githubBlock({ token: 42, note: secret }),
      githubBlock({ email: secret, token: secret }),
    ];

    for (const block of refused) {
      assert.throws(
        () => configuration(withGitHub(block)),
        (error: unknown) => {
          assert.ok(error instanceof WorkspaceError);
          assert.equal(error.message, 'The configuration is invalid.');
          assert.equal(error.message.includes(secret), false);
          return true;
        },
      );
    }
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

  test('reads a GitHub block back as its username, email and stored-token flag', async () => {
    const originalFetch = globalThis.fetch;
    const github = {
      username: 'octocat',
      email: 'octocat@example.com',
      hasToken: true,
    };
    globalThis.fetch = async () =>
      Response.json({ ...snapshot, configuration: { ...valid, github } });

    try {
      const read = await workspaceApi.config.get();
      assert.deepEqual(read.configuration.github, github);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('drops a token a host answered with, so it can never be rendered back', async () => {
    const originalFetch = globalThis.fetch;
    const github = {
      username: 'octocat',
      email: 'octocat@example.com',
      hasToken: true,
    };
    globalThis.fetch = async () =>
      Response.json({
        ...snapshot,
        configuration: { ...valid, github: { ...github, token: 'ghp_leaked' } },
      });

    try {
      const read = await workspaceApi.config.get();
      assert.deepEqual(read.configuration.github, github);
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
      'a GitHub block without its stored-token flag',
      {
        ...snapshot,
        configuration: {
          ...valid,
          github: { username: 'octocat', email: 'octocat@example.com' },
        },
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
