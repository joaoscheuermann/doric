import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import { pino } from 'pino';

import { type ConfigInput, defaultConfig } from '../src/lib/config/schema.js';
import { createConfigService } from '../src/lib/config/service.js';
import { createConfigRouter } from '../src/routes/config.js';
import { createCredentialsRouter } from '../src/routes/credentials.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';
import { deferred } from './helpers/workspace.js';

// A stored configuration's credentials used to be protected by foreign keys.
// The `host-config` references and the core's single write queue now protect
// them, and must refuse the same deletes in both orders of a race.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

interface Host {
  readonly url: string;
  /** Holds the next replacement just before it is stored, until released. */
  hold(): { readonly reached: Promise<void>; release(): void };
}

const withHost = (name: string, run: (host: Host) => Promise<void>) =>
  void test(name, { skip: connectionString === undefined }, async () => {
    assert.ok(connectionString);
    const resources = await persistenceFixture(connectionString);
    try {
      const kernel = await kernelOver(resources.database);
      try {
        let held:
          | { readonly reached: () => void; readonly released: Promise<void> }
          | undefined;
        const config = await createConfigService({
          store: kernel.configs,
          credentials: kernel.credentials,
          catalog: { tools: [], skills: [] },
          logger: pino({ enabled: false }),
          // The model catalogs are the slow step between the credential check
          // and the write, which is where a delete can land.
          readModels: async (configuration) => {
            const gate = held;
            held = undefined;
            gate?.reached();
            await gate?.released;
            return configuration;
          },
        });
        const app = express();
        app.use(express.json());
        app.use('/config', createConfigRouter(config));
        app.use('/credentials', createCredentialsRouter(kernel.credentials));
        const server = createServer(app);
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        try {
          const address = server.address();
          assert.ok(address !== null && typeof address === 'object');
          await run({
            url: `http://127.0.0.1:${address.port}`,
            hold: () => {
              const reached = deferred();
              const released = deferred();
              held = {
                reached: () => reached.resolve(),
                released: released.promise,
              };
              return {
                reached: reached.promise,
                release: () => released.resolve(),
              };
            },
          });
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        await kernel.close();
      }
    } finally {
      await resources.close();
    }
  });

const request = async (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
};

const createCredential = async (host: Host, body: unknown) => {
  const created = await request(host, 'POST', '/credentials', body);
  assert.equal(created.status, 201);
  return (created.body as { id: string }).id;
};

const apiToken = { kind: 'API_TOKEN', name: 'proxy', secret: 'sk_proxy' };
const gitIdentity = {
  kind: 'GIT',
  name: 'github',
  username: 'octocat',
  email: 'octocat@example.com',
};
const githubToken = { kind: 'API_TOKEN', name: 'github', secret: 'ghp_token' };

/** Each way a configuration names a credential. */
const references: readonly {
  readonly name: string;
  readonly credential: unknown;
  readonly naming: (id: string) => ConfigInput;
}[] = [
  {
    name: "a provider's token",
    credential: apiToken,
    naming: (id) => ({
      ...defaultConfig,
      providers: [
        ...defaultConfig.providers,
        {
          id: 'proxy',
          kind: 'openai',
          configuration: { token: id },
          models: [],
        },
      ],
    }),
  },
  {
    name: 'the Git identity',
    credential: gitIdentity,
    naming: (id) => ({ ...defaultConfig, gitCredentialId: id }),
  },
  {
    name: 'the GitHub token',
    credential: githubToken,
    naming: (id) => ({ ...defaultConfig, githubCredentialId: id }),
  },
];

for (const { name, credential, naming } of references) {
  withHost(
    `keeps ${name} the stored configuration names, until a replacement drops it`,
    async (host) => {
      const id = await createCredential(host, credential);

      assert.equal(
        (await request(host, 'PUT', '/config', naming(id))).status,
        200,
      );
      assert.deepEqual(await request(host, 'DELETE', `/credentials/${id}`), {
        status: 409,
        body: {
          error: {
            code: 'credential_referenced',
            message: 'The credential cannot perform this operation.',
          },
        },
      });

      assert.equal(
        (await request(host, 'PUT', '/config', defaultConfig)).status,
        200,
      );
      assert.equal(
        (await request(host, 'DELETE', `/credentials/${id}`)).status,
        204,
      );
      assert.equal(
        (await request(host, 'DELETE', `/credentials/${id}`)).status,
        404,
      );
    },
  );

  withHost(
    `refuses a replacement naming ${name} once a delete landed before its write`,
    async (host) => {
      const id = await createCredential(host, credential);
      const before = await request(host, 'GET', '/config');

      const gate = host.hold();
      const replacing = request(host, 'PUT', '/config', naming(id));
      await gate.reached;

      // The credential was stored when the replacement was checked, and the
      // stored configuration does not name it, so the delete goes through.
      assert.equal(
        (await request(host, 'DELETE', `/credentials/${id}`)).status,
        204,
      );
      gate.release();

      assert.deepEqual(await replacing, {
        status: 503,
        body: {
          error: {
            code: 'configuration_rejected',
            message: 'The Doric configuration could not be activated.',
          },
        },
      });
      assert.deepEqual(await request(host, 'GET', '/config'), before);
    },
  );
}

withHost(
  'never stores a reference to a credential a racing delete removed',
  async (host) => {
    const naming = references[0]?.naming;
    assert.ok(naming);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = await createCredential(host, {
        ...apiToken,
        name: `proxy-${attempt}`,
      });
      const gate = host.hold();
      const replacing = request(host, 'PUT', '/config', naming(id));
      await gate.reached;
      // The write and the delete now race for the one write queue.
      gate.release();
      const [replaced, deleted] = await Promise.all([
        replacing,
        request(host, 'DELETE', `/credentials/${id}`),
      ]);

      assert.ok(
        (replaced.status === 200 && deleted.status === 409) ||
          (replaced.status === 503 && deleted.status === 204),
        `PUT ${replaced.status} with DELETE ${deleted.status}`,
      );

      const stored = (await request(host, 'GET', '/config')).body as {
        configuration: ConfigInput;
      };
      const credentials = (await request(host, 'GET', '/credentials')).body as {
        id: string;
      }[];
      for (const provider of stored.configuration.providers)
        if (provider.configuration.token !== undefined)
          assert.ok(
            credentials.some(
              ({ id: kept }) => kept === provider.configuration.token,
            ),
          );

      // Leave the next attempt the default configuration.
      assert.equal(
        (await request(host, 'PUT', '/config', defaultConfig)).status,
        200,
      );
    }
  },
);
