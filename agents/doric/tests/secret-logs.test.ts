import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';

import type { EmbeddedBundle } from 'bundle';
import { type Log, LogV1 } from 'bundle/contracts';
import express from 'express';
import { pino } from 'pino';

import { pinoSink } from '../src/lib/bundles/boot.js';
import { defaultConfig } from '../src/lib/config/schema.js';
import { createConfigService } from '../src/lib/config/service.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { createConfigRouter } from '../src/routes/config.js';
import { createCredentialsRouter } from '../src/routes/credentials.js';
import { createProvidersRouter } from '../src/routes/providers.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';
import { credentialKey, kernelOver } from './helpers/platform.js';
import { fakeSandbox, pool, workspace } from './helpers/workspace.js';

// No log line may carry a resolved secret: not the host's own lines, not the
// platform's, and not a bundle's `log/v1` records, whatever they contain.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

const providerSecret = 'sk_provider_secret_7f3a';
const githubSecret = 'ghp_github_secret_91c2';

/** A bundle that logs whatever it is handed, as a careless bundle would. */
const careless = () => {
  let log: Log | undefined;
  const bundle: EmbeddedBundle = {
    manifest: {
      manifestVersion: 1,
      id: 'careless',
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      provides: [],
      requires: ['log/v1@^1.0.0'],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id: 'careless', version: '1.0.0' },
      contracts: [],
    },
    host: {
      activate: ({ services }) => {
        log = services.use(LogV1);
      },
    },
  };

  return {
    bundle,
    log: (message: string, fields: Record<string, unknown>) =>
      log?.info(message, fields),
  };
};

/** A model catalog that records the authorization it is sent. */
const catalog = async () => {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    authorizations.push(request.headers.authorization);
    if (request.url === '/broken/models') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `bad key ${providerSecret}` }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'fake/model',
            name: 'Fake model',
            supported_parameters: ['tools', 'tool_choice', 'reasoning'],
            reasoning: { supported_efforts: ['low', 'high'] },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

void test('no host, platform or bundle log line carries a stored or applied secret', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const lines: string[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(line) },
  );
  const resources = await persistenceFixture(connectionString);
  const models = await catalog();
  const probe = careless();
  try {
    const kernel = await kernelOver(
      resources.database,
      { DORIC_CREDENTIAL_KEY: credentialKey },
      {
        embedded: [probe.bundle],
        sink: pinoSink(logger.child({ component: 'bundles' })),
        log: {
          info: (fields, message) => logger.info(fields, message),
          warn: (fields, message) => logger.warn(fields, message),
          error: (fields, message) => logger.error(fields, message),
        },
      },
    );
    try {
      const config = await createConfigService({
        store: kernel.configs,
        credentials: kernel.credentials,
        catalog: () => ({ tools: [], skills: [] }),
        logger,
      });
      const app = express();
      app.use(express.json());
      app.use('/config', createConfigRouter(config));
      app.use('/credentials', createCredentialsRouter(kernel.credentials));
      app.use(
        '/providers',
        createProvidersRouter({ credentials: kernel.credentials, logger }),
      );
      const server = createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = server.address();
        assert.ok(address !== null && typeof address === 'object');
        const host = `http://127.0.0.1:${address.port}`;
        const send = async (method: string, path: string, body: unknown) => {
          const response = await fetch(`${host}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return {
            status: response.status,
            body: (await response.json()) as { id?: string },
          };
        };

        const providerKey = await send('POST', '/credentials', {
          kind: 'API_TOKEN',
          name: 'router',
          secret: providerSecret,
        });
        const identity = await send('POST', '/credentials', {
          kind: 'GIT',
          name: 'github',
          username: 'octocat',
          email: 'octocat@example.com',
        });
        const github = await send('POST', '/credentials', {
          kind: 'API_TOKEN',
          name: 'github',
          secret: githubSecret,
        });
        assert.deepEqual(
          [providerKey.status, identity.status, github.status],
          [201, 201, 201],
        );

        const replaced = await send('PUT', '/config', {
          ...defaultConfig,
          providers: [
            {
              id: 'openrouter',
              kind: 'openrouter',
              configuration: {
                token: providerKey.body.id,
                modelsUrl: `${models.url}/models`,
              },
              models: [{ name: 'fake/model', reasonings: [] }],
            },
            {
              id: 'broken',
              kind: 'openrouter',
              configuration: {
                token: providerKey.body.id,
                modelsUrl: `${models.url}/broken/models`,
              },
              models: [{ name: 'fake/model', reasonings: [] }],
            },
          ],
          models: {
            execution: { providerId: 'openrouter', model: 'fake/model' },
          },
          gitCredentialId: identity.body.id,
          githubCredentialId: github.body.id,
        });
        assert.equal(replaced.status, 200);

        const listed = await send('POST', '/providers/models', {
          kind: 'openrouter',
          configuration: {
            token: providerKey.body.id,
            modelsUrl: `${models.url}/models`,
          },
        });
        assert.equal(listed.status, 200);

        // A prompt's Project gets the Git identity and GitHub token applied.
        const harness = workspace();
        const environment = fakeSandbox();
        const service = createWorkspaceService({
          ...harness.dependencies,
          config,
          credentials: kernel.credentials,
          pool: pool(undefined, environment),
          logger,
          execute: async () => 'done',
        });
        const project = await service.projects.create('Project');
        await harness.projectState(project.id, 'ready');
        assert.ok(
          environment.execs.some(({ env }) =>
            (env ?? []).some((entry) => entry.includes(githubSecret)),
          ),
        );

        probe.log(`router key ${providerSecret} and ${githubSecret}`, {
          request: { headers: { authorization: `Bearer ${providerSecret}` } },
          tokens: [githubSecret],
        });
        await service.dispose();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await kernel.close();
    }
  } finally {
    await models.close();
    await resources.close();
  }

  // The secrets were resolved and used: the catalog saw the provider key.
  assert.ok(models.authorizations.includes(`Bearer ${providerSecret}`));
  const log = lines.join('');
  assert.ok(log.includes('Model catalog could not be read'));
  assert.ok(log.includes('[REDACTED]'));
  assert.equal(log.includes(providerSecret), false);
  assert.equal(log.includes(githubSecret), false);
});
