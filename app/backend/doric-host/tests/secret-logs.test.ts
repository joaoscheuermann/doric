import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { defaultConfig } from 'host-config/testing';

import { callApi } from './helpers/api.js';
import { freshDatabase, startHostProcess } from './helpers/host.js';

// No log line may carry a resolved secret: not the host's own lines, not the
// platform's, and not a record a bundle process writes, through `log/v1` or
// on its stdout (spec section 15, U19). The compiled host runs as an operator
// runs it, with each host part in its own process, and is driven only through
// the public API on its public listener; its whole log file and console are
// scanned. That a bundle's own careless `log/v1` record is redacted is the
// core's rule, tested in bundles/foundation/core (log-redaction).

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const sandboxed = process.env.DORIC_TEST_SANDBOX === 'true';

const providerSecret = 'sk_provider_secret_7f3a';
const githubSecret = 'ghp_github_secret_91c2';

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

void test('no host, platform or bundle process log line carries a stored or applied secret', {
  skip: connectionString === undefined,
  timeout: 300_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  const models = await catalog();
  let output = '';
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      const api = <T = Record<string, unknown>>(
        procedure: string,
        request: unknown,
      ) => callApi<T>(host.url, `doric.api.${procedure}`, request);
      const create = async (request: Record<string, string>) =>
        (
          await api<{ credentialDescription?: { id?: string } }>(
            'credentials.v1.CredentialsService/CreateCredential',
            request,
          )
        ).credentialDescription?.id;

      const providerKey = await create({
        kind: 'API_TOKEN',
        name: 'router',
        secret: providerSecret,
      });
      const identity = await create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      });
      const github = await create({
        kind: 'API_TOKEN',
        name: 'github',
        secret: githubSecret,
      });
      assert.ok(providerKey && identity && github);

      await api('config.v1.ConfigService/PutConfig', {
        configuration: {
          ...defaultConfig,
          providers: [
            {
              id: 'openrouter',
              kind: 'openrouter',
              configuration: {
                token: providerKey,
                modelsUrl: `${models.url}/models`,
              },
              models: [{ name: 'fake/model', reasonings: [] }],
            },
            {
              id: 'broken',
              kind: 'openrouter',
              configuration: {
                token: providerKey,
                modelsUrl: `${models.url}/broken/models`,
              },
              models: [{ name: 'fake/model', reasonings: [] }],
            },
          ],
          models: {
            execution: { providerId: 'openrouter', model: 'fake/model' },
          },
          gitCredentialId: identity,
          githubCredentialId: github,
        },
      });

      // The provider bundle's process resolves the key and reads the catalog.
      await api('providers.v1.ProvidersService/ListModels', {
        kind: 'openrouter',
        configuration: {
          token: providerKey,
          modelsUrl: `${models.url}/models`,
        },
      });

      if (sandboxed) {
        // A Project's sandbox gets the Git identity and the GitHub token.
        const created = await api<{ project?: { id?: string } }>(
          'projects.v1.ProjectsService/CreateProject',
          { name: 'Project' },
        );
        const projectId = created.project?.id;
        assert.ok(projectId);
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const state = (
            await api<{ project?: { state?: string } }>(
              'projects.v1.ProjectsService/GetProject',
              { projectId },
            )
          ).project?.state;
          if (state === 'ready') break;
          assert.notEqual(state, 'failed');
          await delay(200);
        }
      }

      assert.equal(await host.stop(), 0);
      output = await host.output();
    } finally {
      await host.close();
    }
  } finally {
    await models.close();
    await database.close();
  }

  // The secrets were resolved and used: the catalog saw the provider key.
  assert.ok(models.authorizations.includes(`Bearer ${providerSecret}`));
  // A bundle process's record of the broken catalog reached the host's log.
  assert.ok(output.includes('Model catalog could not be read'));
  assert.equal(output.includes(providerSecret), false);
  assert.equal(output.includes(githubSecret), false);
});
