import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import { type CredentialCreate, fromConnectError } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ConfigurationValueSchema } from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import {
  type ConfigInput,
  defaultConfig,
  providerCredentials,
  unpackConfiguration,
} from 'host-config/testing';

import { type HeldCatalog, heldCatalog } from './helpers/held-catalog.js';
import { databaseFixture } from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';

// A stored configuration's credentials used to be protected by foreign keys,
// then by the kernel's one write queue. On the platform the real `host-config`
// process protects them: a replacement in flight is a reference source of
// `secrets/v1` from its credential check until its write settles, and `core`'s
// `Delete` asks every reference source first. The cases call `host-config/v1`
// and `secrets/v1` as `doric`; a test catalog server holds a replacement in
// flight between its credential check and its write (it reads the catalog of
// the `openrouter` provider every naming below adds).

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

/** What `host-config/v1.Replace` answered, as the case reads it. */
type Replaced =
  | { readonly status: 'replaced' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'rejected' };

/**
 * The platform as the race reads it, every call made as `doric`:
 * - `replace`/`current`: `host-config/v1.Replace{input}` (the configuration as a
 *   `google.protobuf.Value`) and `Current{}` (its `configuration` as JSON), so
 *   the real `host-config` process runs the pipeline and keeps its in-flight
 *   references;
 * - `create`/`remove`/`stored`: `secrets/v1.Create`, `Delete{credentialRef}`
 *   and `List`, served by the `core` process.
 * Any call failing with a `ContractError` fails the case.
 */
interface Host {
  replace(configuration: ConfigInput): Promise<Replaced>;
  current(): Promise<ConfigInput>;
  create(input: CredentialCreate): Promise<string>;
  remove(id: string): Promise<'deleted' | 'missing' | 'referenced'>;
  /** The credential ids `secrets/v1.List` answers now. */
  stored(): Promise<readonly string[]>;
  /** The held catalog every naming below routes its replacement through. */
  readonly catalog: HeldCatalog;
}

/** A router call's failure as its Doric error; any other error unchanged. */
const called = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw error instanceof Error && error.name === 'ConnectError'
      ? fromConnectError(error as Parameters<typeof fromConnectError>[0])
      : error;
  }
};

const withHost = (name: string, run: (host: Host) => Promise<void>) =>
  void test(name, { skip: connectionString === undefined }, async () => {
    assert.ok(connectionString);
    const resources = await databaseFixture(connectionString);
    try {
      const catalog = await heldCatalog();
      try {
        const kernel = await kernelOver(resources);
        try {
          const config = kernel.platform.client(HostConfigService);
          const secrets = kernel.platform.client(SecretsService);

          await run({
            catalog,
            replace: async (configuration) => {
              const { status } = await called(
                config.replace({
                  input: fromJson(ValueSchema, configuration as JsonValue),
                }),
              );
              switch (status.case) {
                case 'replaced':
                  return { status: 'replaced' };
                case 'invalid':
                  return { status: 'invalid', message: status.value.message };
                case 'rejected':
                  return { status: 'rejected' };
                default:
                  throw new Error('host-config/v1.Replace answered no status.');
              }
            },
            current: async () => {
              const { doricConfiguration } = await called(config.current({}));
              const configuration = doricConfiguration?.configuration;
              assert.ok(configuration, 'Current answered no configuration');
              return unpackConfiguration(
                anyPack(ConfigurationValueSchema, configuration),
              );
            },
            create: async (input) => {
              const { credentialDescription } = await called(
                secrets.create(input),
              );
              assert.ok(credentialDescription, 'Create answered no credential');
              return credentialDescription.id;
            },
            remove: async (id) => {
              const { result } = await called(
                secrets.delete({ credentialRef: { id } }),
              );
              assert.ok(
                result === 'deleted' ||
                  result === 'missing' ||
                  result === 'referenced',
                `Delete answered ${result}`,
              );
              return result;
            },
            stored: async () =>
              (await called(secrets.list({}))).credentials.map(({ id }) => id),
          });
        } finally {
          await kernel.close();
        }
      } finally {
        await catalog.close();
      }
    } finally {
      await resources.close();
    }
  });

const catalogCredential: CredentialCreate = {
  kind: 'API_TOKEN',
  name: 'catalog',
  secret: 'sk_catalog',
};
const apiToken: CredentialCreate = {
  kind: 'API_TOKEN',
  name: 'proxy',
  secret: 'sk_proxy',
};
const gitIdentity: CredentialCreate = {
  kind: 'GIT',
  name: 'github',
  username: 'octocat',
  email: 'octocat@example.com',
};
const githubToken: CredentialCreate = {
  kind: 'API_TOKEN',
  name: 'github',
  secret: 'ghp_token',
};

/** `defaultConfig` plus the `openrouter` provider `held`, whose catalog every replacement reads. */
const withHeld = (
  catalog: HeldCatalog,
  token: string,
  extra: Partial<ConfigInput> = {},
): ConfigInput => ({
  ...defaultConfig,
  providers: [
    ...defaultConfig.providers,
    {
      id: 'held',
      kind: 'openrouter',
      configuration: { endpoint: catalog.endpoint, token },
      models: [{ name: catalog.model, reasonings: [] }],
    },
  ],
  ...extra,
});

/**
 * Each way a configuration names a credential. `naming(id, catalogToken,
 * catalog)` is `defaultConfig` plus, always, an `openrouter` provider `held`
 * whose `endpoint` is `catalog`'s and whose `models` lists its model (so
 * every replacement reads the catalog), and the reference under test:
 * - a provider's token: `held`'s own `token` is `id`;
 * - the Git identity: `gitCredentialId: id` (`held`'s token is `catalogToken`);
 * - the GitHub token: `githubCredentialId: id` (`held`'s token is `catalogToken`).
 * `catalogToken` is an `API_TOKEN` credential the case creates first and never
 * deletes. `invalidMessage` is today's answer when `id` is not stored.
 */
const references: readonly {
  readonly name: string;
  readonly credential: CredentialCreate;
  readonly naming: (
    id: string,
    catalogToken: string,
    catalog: HeldCatalog,
  ) => ConfigInput;
  readonly invalidMessage: string;
}[] = [
  {
    name: "a provider's token",
    credential: apiToken,
    naming: (id, _catalogToken, catalog) => withHeld(catalog, id),
    invalidMessage:
      'Provider held token references a credential that is not stored.',
  },
  {
    name: 'the Git identity',
    credential: gitIdentity,
    naming: (id, catalogToken, catalog) =>
      withHeld(catalog, catalogToken, { gitCredentialId: id }),
    invalidMessage:
      'The Git identity references a credential that is not stored.',
  },
  {
    name: 'the GitHub token',
    credential: githubToken,
    naming: (id, catalogToken, catalog) =>
      withHeld(catalog, catalogToken, { githubCredentialId: id }),
    invalidMessage:
      'The GitHub credential references a credential that is not stored.',
  },
];

/** Every credential id `configuration` names. */
const namedIds = (configuration: ConfigInput): string[] => [
  ...configuration.providers.flatMap((provider) =>
    providerCredentials(provider).map(({ id }) => id),
  ),
  ...(configuration.gitCredentialId === undefined
    ? []
    : [configuration.gitCredentialId]),
  ...(configuration.githubCredentialId === undefined
    ? []
    : [configuration.githubCredentialId]),
];

/** The invariant: every credential id the stored configuration names is stored. */
const assertNamesOnlyStored = async (host: Host): Promise<void> => {
  const stored = await host.stored();
  for (const id of namedIds(await host.current()))
    assert.ok(
      stored.includes(id),
      `the stored configuration names ${id}, which is not stored`,
    );
};

for (const { name, credential, naming, invalidMessage } of references) {
  withHost(
    `keeps ${name} the stored configuration names, until a replacement drops it`,
    async (host) => {
      const catalogToken = await host.create(catalogCredential);
      const id = await host.create(credential);

      assert.deepEqual(
        await host.replace(naming(id, catalogToken, host.catalog)),
        {
          status: 'replaced',
        },
      );
      assert.equal(await host.remove(id), 'referenced');

      assert.deepEqual(await host.replace(defaultConfig), {
        status: 'replaced',
      });
      assert.equal(await host.remove(id), 'deleted');
      assert.equal(await host.remove(id), 'missing');
      await assertNamesOnlyStored(host);
    },
  );

  withHost(
    `a delete while a replacement naming ${name} is in flight answers referenced, and the replacement is stored`,
    async (host) => {
      const catalogToken = await host.create(catalogCredential);
      const id = await host.create(credential);

      const gate = host.catalog.hold();
      const replacing = host.replace(naming(id, catalogToken, host.catalog));
      await gate.reached;

      // The replacement passed its credential check and has not written yet.
      assert.equal(await host.remove(id), 'referenced');
      gate.release();

      assert.deepEqual(await replacing, { status: 'replaced' });
      assert.ok(namedIds(await host.current()).includes(id));
      assert.ok((await host.stored()).includes(id));
      await assertNamesOnlyStored(host);
    },
  );

  withHost(
    `a replacement naming ${name} after its delete answers invalid with today's message and keeps the stored configuration`,
    async (host) => {
      const catalogToken = await host.create(catalogCredential);
      const id = await host.create(credential);
      const before = await host.current();

      assert.equal(await host.remove(id), 'deleted');
      assert.deepEqual(
        await host.replace(naming(id, catalogToken, host.catalog)),
        {
          status: 'invalid',
          message: invalidMessage,
        },
      );
      assert.deepEqual(await host.current(), before);
      await assertNamesOnlyStored(host);
    },
  );
}

withHost(
  'never stores a reference to a credential a racing delete removed',
  async (host) => {
    const provider = references[0];
    assert.ok(provider);
    const { naming, invalidMessage } = provider;
    const catalogToken = await host.create(catalogCredential);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = await host.create({
        ...apiToken,
        name: `proxy-${String(attempt)}`,
      });
      // Both start together, one delayed by `attempt` ms: the delete on even
      // attempts, the replacement on odd ones, so that both orders occur.
      const [replaced, deleted] = await Promise.all([
        delay(attempt % 2 === 1 ? attempt : 0).then(() =>
          host.replace(naming(id, catalogToken, host.catalog)),
        ),
        delay(attempt % 2 === 0 ? attempt : 0).then(() => host.remove(id)),
      ]);

      assert.ok(
        (replaced.status === 'replaced' && deleted === 'referenced') ||
          (replaced.status === 'invalid' &&
            replaced.message === invalidMessage &&
            deleted === 'deleted'),
        `attempt ${String(attempt)}: replace ${JSON.stringify(replaced)} with delete ${deleted}`,
      );
      await assertNamesOnlyStored(host);
    }
  },
);
