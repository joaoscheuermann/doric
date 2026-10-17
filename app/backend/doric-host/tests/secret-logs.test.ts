import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { defaultConfig } from 'host-config/testing';

import { freshDatabase, startHostProcess } from './helpers/host.js';

// No log line may carry a resolved secret: not the host's own lines, not the
// platform's, and not a bundle's `log/v1` records. The compiled host runs as
// an operator runs it, and its whole log file and console are scanned. That a
// bundle's own careless `log/v1` record is redacted is the core's rule, tested
// in bundles/foundation/core (log-redaction).

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

void test('no host, platform or bundle log line carries a stored or applied secret', {
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
      const send = async (method: string, path: string, body: unknown) => {
        const response = await host.request(path, method, body);
        return {
          status: response.status,
          body: (await response.json()) as { id?: string; state?: string },
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

      if (sandboxed) {
        // A Project's sandbox gets the Git identity and the GitHub token.
        const project = await send('POST', '/projects', { name: 'Project' });
        assert.equal(project.status, 202);
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const state = (
            await send('GET', `/projects/${project.body.id}`, undefined)
          ).body.state;
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
  assert.ok(output.includes('Model catalog could not be read'));
  assert.equal(output.includes(providerSecret), false);
  assert.equal(output.includes(githubSecret), false);
});
