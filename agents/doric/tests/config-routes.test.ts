import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import { providerKinds } from 'llms';
import { pino } from 'pino';

import { type ConfigInput, defaultConfig } from '../src/lib/config/schema.js';
import { ConfigCredentialError } from '../src/lib/config/service.js';
import type { Credential } from '../src/lib/credentials/kind.js';
import { createConfigRouter } from '../src/routes/config.js';
import { createProvidersRouter } from '../src/routes/providers.js';
import { credentialResolver } from './helpers/workspace.js';

const gitCredentialId = '00000000-0000-4000-8000-00000000000a';
/** The credential a provider names when a case reads its catalog. */
const providerCredential: Credential = {
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'API_TOKEN',
  name: 'OPENROUTER_API_KEY',
  secret: 'sk_stored_key',
};

const logger = pino({ enabled: false });

void test('answers the provider-kind catalog the host can build', async () => {
  const app = express();

  app.use(
    '/providers',
    createProvidersRouter({ credentials: credentialResolver(), logger }),
  );

  const host = await serve(app);

  try {
    const response = await fetch(`${host.url}/providers/kinds`);

    assert.equal(response.status, 200);

    const body = (await response.json()) as { kinds: unknown };

    // The route is the catalog itself, so a kind's fields and lists arrive
    // exactly as llms declares them.
    assert.deepEqual(body.kinds, JSON.parse(JSON.stringify(providerKinds)));
    assert.deepEqual(
      (body.kinds as readonly { id: string }[]).map(({ id }) => id),
      ['openai', 'openrouter'],
    );
  } finally {
    await host.close();
  }
});

void test('answers the models a provider catalog describes', async () => {
  const catalog = 'https://catalog.example.com/models';
  const requests: { readonly url: string }[] = [];
  const host = await serveProviders({
    credentials: credentialResolver(() => [providerCredential]),
    // The endpoint is answered here, so no case reaches a real one.
    transport: {
      request: (request: { readonly url: string }) => {
        requests.push({ url: request.url });

        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5',
                name: 'OpenAI: GPT-5',
                supported_parameters: ['tools', 'tool_choice'],
                reasoning: { supported_efforts: ['high', 'medium'] },
              },
            ],
          }),
        });
      },
    },
  });

  try {
    const response = await fetch(`${host.url}/providers/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'openrouter',
        configuration: { modelsUrl: catalog, token: providerCredential.id },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requests[0]?.url, catalog);
    assert.deepEqual(await response.json(), {
      models: [
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-5',
          parameters: ['tools', 'tool_choice'],
          reasonings: ['high', 'medium'],
          mandatory: false,
        },
      ],
    });
  } finally {
    await host.close();
  }
});

void test('answers a catalog it cannot read as its own error', async () => {
  const host = await serveProviders({
    credentials: credentialResolver(),
    transport: {
      request: () => Promise.resolve({ status: 500, headers: {}, body: '' }),
    },
  });

  try {
    const response = await fetch(`${host.url}/providers/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'openrouter',
        configuration: { token: '00000000-0000-4000-8000-000000000002' },
      }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'model_catalog_unreadable',
        message: 'The provider model catalog could not be read.',
      },
    });
  } finally {
    await host.close();
  }
});

void test('refuses provider values the kind does not declare', async () => {
  const host = await serveProviders({ credentials: credentialResolver() });

  try {
    const response = await fetch(`${host.url}/providers/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'lmstudio',
        configuration: { identityId: 'local' },
      }),
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_provider',
        message: 'The provider values are invalid.',
      },
    });
  } finally {
    await host.close();
  }
});

void test('returns the active configuration at the root config route', async () => {
  const active = snapshot(1);

  const host = await serveConfig({
    current: () => ({ snapshot: active }),
  });

  try {
    const current = await fetch(`${host.url}/config`);

    assert.equal(current.status, 200);

    assert.deepEqual(await current.json(), active);
  } finally {
    await host.close();
  }
});

void test('replaces the complete configuration at the root config route', async () => {
  let active = snapshot(1);

  const host = await serveConfig({
    current: () => ({ snapshot: active }),
    replace: async (configuration: ConfigInput) => {
      active = { ...snapshot(2), configuration };

      return active;
    },
  });
  const replacement = structuredClone(defaultConfig);

  replacement.models.execution.model = 'replacement';
  replacement.gitCredentialId = gitCredentialId;

  try {
    const response = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(replacement),
    });

    assert.equal(response.status, 200);

    assert.deepEqual(await response.json(), {
      ...snapshot(2),
      configuration: replacement,
    });
  } finally {
    await host.close();
  }
});

void test('rejects an invalid configuration without activating it', async () => {
  let replacements = 0;

  const host = await serveConfig({
    current: () => ({ snapshot: snapshot(1) }),
    replace: async () => {
      replacements += 1;

      return snapshot(2);
    },
  });

  try {
    const invalid = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...defaultConfig, providers: [] }),
    });

    assert.equal(invalid.status, 422);

    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      'invalid_config',
    );

    assert.equal(replacements, 0);
  } finally {
    await host.close();
  }
});

void test('rejects a configuration whose credential reference is unusable', async () => {
  let replacements = 0;

  const host = await serveConfig({
    current: () => ({ snapshot: snapshot(1) }),
    replace: async () => {
      replacements += 1;

      throw new ConfigCredentialError(
        'Provider openrouter must reference an API_TOKEN credential, not a GIT one.',
      );
    },
  });

  try {
    const response = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultConfig),
    });
    const body = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'invalid_config');
    assert.equal(replacements, 1);
  } finally {
    await host.close();
  }
});

void test('returns a stable error when configuration activation fails', async () => {
  const host = await serveConfig({
    current: () => ({ snapshot: snapshot(1) }),
    replace: async () => {
      throw new Error('provider secret');
    },
  });

  try {
    const response = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultConfig),
    });

    assert.equal(response.status, 503);

    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'configuration_rejected',
    );
  } finally {
    await host.close();
  }
});

const snapshot = (revision: number, extra: Partial<ConfigInput> = {}) => ({
  configuration: { ...defaultConfig, ...extra },
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});

/** The provider routes, over the kind catalog and a catalog read that a case answers. */
const serveProviders = async (options: {
  readonly credentials: unknown;
  readonly transport?: unknown;
}) => {
  const app = express();

  app.use(express.json());

  app.use(
    '/providers',
    createProvidersRouter({
      credentials: options.credentials,
      logger,
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    } as never),
  );

  return serve(app);
};

const serveConfig = async (service: unknown) => {
  const app = express();

  app.use(express.json());

  app.use('/config', createConfigRouter(service as never));

  return serve(app);
};

const serve = async (app: express.Express) => {
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
};
