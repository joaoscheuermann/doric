import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  ContractError,
  type CredentialCreate,
  type CredentialDescription,
  type CredentialUpdate,
  defineSettings,
  fromConnectError,
  type Secret,
  type Secrets,
  type SecretsView,
  type Settings,
} from 'bundle/contracts';
import {
  type CredentialDescription as DescriptionMessage,
  type Secret as SecretMessage,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  type SettingsEntry as EntryMessage,
  SettingsService,
} from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import type { Platform } from 'bundle/platform';
import {
  type ConfigInput,
  ConfigInputSchema,
  type ConfigStore,
  type CredentialService,
  createConfigStore,
  createCredentialService,
  packConfiguration,
  unpackConfiguration,
} from 'host-config/testing';
import pino from 'pino';

import { startHostPlatform } from '../../src/lib/bundles/boot.js';
import { ApiError, callApi } from './api.js';
import { childProcesses, spawnedBundles } from './processes.js';

/*
 * The host's configuration and credential behaviour on the platform, as the
 * host now boots it (`startHostPlatform`): the staged `postgres`, `core` and
 * `host-config`, one process each, with `DORIC_DATABASE_URL` the fixture's.
 * The kernel-shaped `credentials` and `configs` the tests drive are adapters
 * over the `doric` caller's clients of `secrets/v1` and `settings/v1`: the
 * same `CredentialService` and `ConfigStore` rules (`host-config/testing`),
 * with every read and write a call to the `core` process.
 */

/** The built bundles the host stages in `dist/bundles`. */
export const bundlesPath = 'app/backend/doric-host/dist/bundles';

/** 32 zero bytes, base64. A fixed test key, never a deployed one. */
export const credentialKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The foundation the helper's composition chooses for both backends: the staged `postgres`. */
export const testFoundationId = 'postgres';

/**
 * The bundles the helper's composition enables, each one process: the
 * configuration owner, the core and its foundation, and the model providers
 * `host-config` prepares the stored configuration's providers with at start.
 */
const composed = [
  'claude',
  'codex',
  'core',
  'host-config',
  'openai',
  'openrouter',
  testFoundationId,
] as const;

export interface Kernel extends KernelPlatform {
  /** The credential service over `secrets/v1`, loaded as the host loads it. */
  readonly credentials: CredentialService;
  /** The configuration store over the `host-config` settings space of `settings/v1`. */
  readonly configs: ConfigStore;
}

export interface KernelOptions {
  /** The database fixture the staged `postgres` serves: its URL becomes `DORIC_DATABASE_URL`. */
  readonly database: { readonly url: string };
  /**
   * The bundle processes' further `DORIC_*` variables, such as
   * `DORIC_CREDENTIAL_KEY`; an `undefined` value is left out. None by default.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** The booted platform, before anything reads credentials or configuration. */
export interface KernelPlatform {
  /** The platform; its `client` is the `doric` caller. */
  readonly platform: Platform;
  close(): Promise<void>;
}

/** This process's environment without `DORIC_*`, plus `extra`'s defined values. */
const bundleEnvironment = (
  extra: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('DORIC_')),
  ),
  ...Object.fromEntries(
    Object.entries(extra).filter(([, value]) => value !== undefined),
  ),
});

/**
 * Asserts the boot is the platform's, not the kernel's: every child of this
 * process runs a staged bundle's own command (no kernel runner), every
 * composed bundle among them, and the platform's public listener answers
 * (HTTP 404 for `doric.api.status/v1`, which no composed bundle serves).
 */
const assertPlatformBoot = async (platform: Platform): Promise<void> => {
  const spawned = await spawnedBundles(
    bundlesPath,
    await childProcesses(process.pid),
  );

  assert.deepEqual([...new Set(spawned)].sort(), [...composed].sort());
  assert.ok(platform.publicPort, 'the public listener is bound');
  await assert.rejects(
    callApi(
      `http://127.0.0.1:${String(platform.publicPort)}`,
      'doric.api.status.v1.StatusService/Watch',
    ),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
};

/**
 * Boots the platform as the host does (`startHostPlatform`), over the staged
 * `dist/bundles`, with a composition of `postgres`, `core`, `host-config` and
 * the four model providers (`host-config/v1` required), on a free port of 127.0.0.1. The host's start
 * hooks run, so `host-config` has activated the stored configuration.
 * Rejects as the host's boot does (a `BundleRecoveryError`, a failing start
 * hook), with nothing left running.
 */
export const startPlatform = async ({
  database,
  environment = {},
}: KernelOptions): Promise<KernelPlatform> => {
  const { platform } = await startHostPlatform({
    bundlesPath,
    // No `composition.overrides.json` lives beside it.
    compositionPath: join('app/backend/doric-host/dist-tests', 'kernel.json'),
    composition: {
      core: 'core',
      enabled: [...composed],
      providers: {
        'storage.backend/v1': testFoundationId,
        'secrets.backend/v1': testFoundationId,
      },
    },
    required: { contracts: ['host-config/v1'], bundles: [] },
    publicAddress: '127.0.0.1:0',
    startup: { stage: () => undefined, log: () => undefined },
    logger: pino({ enabled: false }),
    exit: () => undefined,
    env: bundleEnvironment({
      ...environment,
      DORIC_DATABASE_URL: database.url,
    }),
  });

  try {
    await assertPlatformBoot(platform);
  } catch (error) {
    await platform.shutdown();
    throw error;
  }

  return { platform, close: () => platform.shutdown() };
};

type ConnectFailure = Parameters<typeof fromConnectError>[0];

/** A router call's failure as its Doric error; any other error unchanged. */
const called = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw error instanceof Error && error.name === 'ConnectError'
      ? fromConnectError(error as ConnectFailure)
      : error;
  }
};

/** A `Secret` message as the plain value the kernel's view answered. */
const secretOf = ({
  id,
  kind,
  name,
  username,
  email,
  secret,
}: SecretMessage): Secret => ({
  id,
  kind,
  name,
  ...(username === undefined ? {} : { username }),
  ...(email === undefined ? {} : { email }),
  ...(secret === undefined ? {} : { secret }),
});

/** A `CredentialDescription` message as the plain value `secrets/v1` answers. */
const describedOf = ({
  id,
  kind,
  name,
  username,
  email,
  hasSecret,
}: DescriptionMessage): CredentialDescription => ({
  id,
  kind,
  name,
  ...(username === undefined ? {} : { username }),
  ...(email === undefined ? {} : { email }),
  hasSecret,
});

/** A credential update without the `null`s `secrets/v1` reads as absent. */
const updateOf = (input: CredentialUpdate) =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value != null),
  ) as { [Key in keyof CredentialUpdate]: string };

/**
 * The part of `secrets/v1` `createCredentialService` reads, over the `doric`
 * client. `view()` is the synchronous in-process view the kernel answered:
 * here a copy of the `core` cache (`ListSecrets`, `Redactions`), read again
 * after the first `list` and after every write, before the write resolves.
 * `addRedaction` adds to the copy at once and sends `AddRedaction`, which the
 * next read waits for.
 */
const secretsOver = (platform: Platform) => {
  const client = platform.client(SecretsService);
  let listed: readonly Secret[] = [];
  let redactions: readonly string[] = [];
  let sent: Promise<unknown> = Promise.resolve();
  let asked = 0;
  let applied = 0;

  /** Reads the cache again; a read that started earlier never overwrites a later one. */
  const reread = async (): Promise<void> => {
    const ticket = ++asked;

    await sent;
    const [secrets, redacted] = await Promise.all([
      called(client.listSecrets({})),
      called(client.redactions({})),
    ]);

    if (ticket < applied) return;
    applied = ticket;
    listed = secrets.secrets.map(secretOf);
    redactions = [...redacted.redactions];
  };

  const view: SecretsView = {
    list: () => listed,
    redactions: () => redactions,
    addRedaction: (secret) => {
      redactions = [...redactions, secret];
      sent = Promise.all([sent, called(client.addRedaction({ secret }))]).catch(
        () => undefined,
      );
    },
  };

  /** A write's answer, once the copy of the cache holds what it wrote. */
  const written = async (
    request: Promise<{ credentialDescription?: DescriptionMessage }>,
  ): Promise<CredentialDescription> => {
    const { credentialDescription } = await called(request);

    await reread();
    if (credentialDescription === undefined)
      throw new ContractError('internal', 'secrets/v1 answered no credential.');

    return describedOf(credentialDescription);
  };

  const secrets: Pick<
    Secrets,
    'list' | 'view' | 'create' | 'update' | 'delete'
  > = {
    list: async () => {
      const { credentials } = await called(client.list({}));

      await reread();

      return credentials.map(describedOf);
    },
    view: () => view,
    create: (input: CredentialCreate) => written(client.create(input)),
    update: (ref, input) =>
      written(client.update({ ref: { id: ref.id }, update: updateOf(input) })),
    delete: async (ref) => {
      const { result } = await called(
        client.delete({ credentialRef: { id: ref.id } }),
      );

      await reread();

      return result as 'deleted' | 'missing' | 'referenced';
    },
  };

  return secrets;
};

/**
 * A settings entry's `ConfigurationValue` as the configuration it holds, read
 * as `host-config` reads it (`unpackConfiguration`).
 */
const entryOf = (entry: EntryMessage | undefined) => {
  if (entry === undefined)
    throw new ContractError('internal', 'settings/v1 answered no entry.');

  return {
    value: unpackConfiguration(entry.value),
    revision: entry.revision,
    version: entry.version,
    updatedAt: entry.updatedAt,
    generation: entry.generation,
  };
};

/**
 * The part of `settings/v1` `createConfigStore` reads (`entry`, `set`), over
 * the `doric` client: the space's value packed and unpacked as the
 * `ConfigurationValue` `host-config` registered it with.
 */
const settingsOver = (platform: Platform) => {
  const client = platform.client(SettingsService);
  const settings: Pick<Settings, 'entry' | 'set'> = {
    entry: async (definition) =>
      entryOf(
        (await called(client.entry({ id: definition.id }))).settingsEntry,
      ),
    set: async (definition, value) =>
      entryOf(
        (
          await called(
            client.set({
              id: definition.id,
              value: packConfiguration(value as ConfigInput),
            }),
          )
        ).settingsEntry,
      ),
  } as Pick<Settings, 'entry' | 'set'>;

  return settings;
};

/**
 * The platform with the credential service and the configuration store. Like
 * the host's kernel did, it loads the credentials before anything reads the
 * configuration, so a credential that cannot be read fails here, after the
 * platform was shut down.
 */
export const startKernel = async (options: KernelOptions): Promise<Kernel> => {
  const { platform, close } = await startPlatform(options);

  try {
    // The git bundle registers the GIT kind when it activates; this
    // composition has no git, so the registration is made here, as `doric`.
    await called(
      platform.client(SecretsService).registerKind({
        credentialKindDefinition: {
          id: 'GIT',
          required: ['username', 'email'],
          optional: [],
        },
      }),
    );

    // Only `list`, `view`, `create`, `update` and `delete` are read.
    const credentials = await createCredentialService({
      secrets: secretsOver(platform) as Secrets,
    });
    // Only `entry` and `set` are read, and only the definition's id.
    const configs = createConfigStore({
      settings: settingsOver(platform) as Settings,
      definition: defineSettings({
        id: 'host-config.configuration/v1',
        schema: ConfigInputSchema,
      }),
      track: () => undefined,
    });

    return { platform, credentials, configs, close };
  } catch (error) {
    await close();
    throw error;
  }
};

/**
 * The platform over a database fixture (its `url`). The fixture stays the
 * caller's to close; the credential key is the fixed test key unless
 * `environment` says otherwise.
 */
export const kernelOver = (
  database: { readonly url: string },
  environment: Readonly<Record<string, string | undefined>> = {
    DORIC_CREDENTIAL_KEY: credentialKey,
  },
): Promise<Kernel> => startKernel({ database, environment });
