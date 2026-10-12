import assert from 'node:assert/strict';
import test from 'node:test';

import type { CredentialCreate } from 'bundle/contracts';
import {
  type ConfigInput,
  createConfigService,
  defaultConfig,
} from 'host-config/testing';

import { deferred } from './helpers/credentials.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';

// A stored configuration's credentials used to be protected by foreign keys.
// The `host-config` references and the core's single write queue now protect
// them, and must refuse the same deletes in both orders of a race. The cases
// call `host-config/v1`'s replacement pipeline and the credential service
// directly; the transport maps their outcomes to the same statuses as before
// (replaced 200, rejected 503, referenced 409, deleted 204, missing 404),
// which bundles/foundation/transport tests the routes for.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

interface Host {
  replace(configuration: ConfigInput): Promise<string>;
  current(): Promise<unknown>;
  create(input: unknown): Promise<string>;
  remove(id: string): Promise<string>;
  /** The credential ids the store holds. */
  stored(): readonly string[];
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
        const config = createConfigService({
          store: kernel.configs,
          credentials: async () => kernel.credentials,
          tools: () => [],
          models: {
            catalog: async () => ({ status: 'absent' }),
            // Building the candidate providers is the slow step between the
            // credential check and the write, which is where a delete can land.
            prepare: async (input) => {
              if (typeof input.revision === 'number') return;
              const gate = held;
              held = undefined;
              gate?.reached();
              await gate?.released;
            },
          },
        });
        await run({
          replace: async (configuration) =>
            (await config.replace(configuration)).status,
          current: () => config.current(),
          create: async (input) => {
            const written = await kernel.credentials.create(
              input as CredentialCreate,
            );
            assert.equal(written.status, 'saved');
            assert.ok(written.status === 'saved');
            return written.credential.id;
          },
          remove: (id) => kernel.credentials.remove(id),
          stored: () => kernel.credentials.list().map(({ id }) => id),
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
        await kernel.close();
      }
    } finally {
      await resources.close();
    }
  });

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
      const id = await host.create(credential);

      assert.equal(await host.replace(naming(id)), 'replaced');
      assert.equal(await host.remove(id), 'referenced');

      assert.equal(await host.replace(defaultConfig), 'replaced');
      assert.equal(await host.remove(id), 'deleted');
      assert.equal(await host.remove(id), 'missing');
    },
  );

  withHost(
    `refuses a replacement naming ${name} once a delete landed before its write`,
    async (host) => {
      const id = await host.create(credential);
      const before = await host.current();

      const gate = host.hold();
      const replacing = host.replace(naming(id));
      await gate.reached;

      // The credential was stored when the replacement was checked, and the
      // stored configuration does not name it, so the delete goes through.
      assert.equal(await host.remove(id), 'deleted');
      gate.release();

      assert.equal(await replacing, 'rejected');
      assert.deepEqual(await host.current(), before);
    },
  );
}

withHost(
  'never stores a reference to a credential a racing delete removed',
  async (host) => {
    const naming = references[0]?.naming;
    assert.ok(naming);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = await host.create({
        ...apiToken,
        name: `proxy-${attempt}`,
      });
      const gate = host.hold();
      const replacing = host.replace(naming(id));
      await gate.reached;
      // The write and the delete now race for the one write queue.
      gate.release();
      const [replaced, deleted] = await Promise.all([
        replacing,
        host.remove(id),
      ]);

      assert.ok(
        (replaced === 'replaced' && deleted === 'referenced') ||
          (replaced === 'rejected' && deleted === 'deleted'),
        `replace ${replaced} with delete ${deleted}`,
      );

      const stored = (await host.current()) as {
        configuration: ConfigInput;
      };
      for (const provider of stored.configuration.providers)
        if (provider.configuration.token !== undefined)
          assert.ok(host.stored().includes(provider.configuration.token));

      // Leave the next attempt the default configuration.
      assert.equal(await host.replace(defaultConfig), 'replaced');
    }
  },
);
