import {
  type EmbeddedBundle,
  type HostPlatform,
  type LogSink,
  type PlatformLog,
  startHost,
} from 'bundle';
import { SecretsV1, SettingsV1 } from 'bundle/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import { createHostConfig, type HostConfig } from 'host-config/kernel';
import {
  type ConfigStore,
  type CredentialService,
  createConfigStore,
  createCredentialService,
} from 'host-config/testing';
import type { Database } from 'postgres/prisma';
import { postgresEmbedded } from 'postgres/testing';

/** The built bundles the host stages in `dist/bundles`. */
export const bundlesPath = 'app/backend/doric-host/dist/bundles';

/** 32 zero bytes, base64. A fixed test key, never a deployed one. */
export const credentialKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * The embedded `postgres` foundation's ID in tests. The staged `postgres` sits
 * beside the core in `dist/bundles`, so the embedded copy needs its own ID.
 */
export const testFoundationId = 'postgres-test';

export interface Kernel extends KernelPlatform {
  /** The credential service, loaded as `credential_activation` loads it. */
  readonly credentials: CredentialService;
  /** The configuration store over the `host-config` settings space. */
  readonly configs: ConfigStore;
}

export interface KernelOptions {
  /** The foundation chosen for both backends. */
  readonly foundation: EmbeddedBundle;
  /** Further embedded bundles, such as a probe that logs through `log/v1`. */
  readonly embedded?: readonly EmbeddedBundle[];
  readonly sink?: LogSink;
  readonly log?: PlatformLog;
  /**
   * Loads the stored configuration once, as `configuration_activation` does,
   * so the credentials it references are protected from the start.
   */
  readonly configuration?: boolean;
}

const silent: PlatformLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The booted bundles, before anything reads credentials or configuration. */
export interface KernelPlatform {
  readonly platform: HostPlatform;
  readonly hostConfig: HostConfig;
  close(): Promise<void>;
}

/**
 * Boots the kernel's bundle pieces as the host does: the built core from
 * `dist/bundles` over the given foundation, with the embedded `host-config`.
 * Activation opens no database.
 */
export const startPlatform = async ({
  foundation,
  embedded = [],
  sink = { write: () => undefined },
  log = silent,
}: KernelOptions): Promise<KernelPlatform> => {
  const hostConfig = createHostConfig();
  const id = foundation.manifest.id;
  const platform = await startHost({
    bundlesPath,
    composition: {
      core: 'core',
      enabled: ['core', 'host-config', id],
      providers: { 'storage.backend/v1': id, 'secrets.backend/v1': id },
    },
    embedded: [foundation, ...embedded],
    log,
    sink,
  });

  if (platform.mode !== 'normal') {
    const reason = platform.diagnostics().recovery?.reason;

    await platform.stop();
    throw new Error(`The test kernel is in recovery: ${reason}`);
  }

  // The git bundle registers the GIT kind when it activates; this kernel
  // composes without git, so the registration the host would make is made here.
  platform.services.use(SecretsV1).registerKind({
    id: 'GIT',
    required: ['username', 'email'],
    optional: [],
  });

  return { platform, hostConfig, close: () => platform.stop() };
};

/**
 * The platform with the credential service and the configuration store. Like
 * the host, it loads the credentials before anything reads the configuration,
 * so a credential that cannot be read fails here.
 */
export const startKernel = async (options: KernelOptions): Promise<Kernel> => {
  const { platform, hostConfig, close } = await startPlatform(options);

  try {
    const credentials = await createCredentialService({
      secrets: platform.services.use(SecretsV1),
    });
    const configs = createConfigStore({
      settings: platform.services.use(SettingsV1),
      definition: hostConfig.definition,
      track: hostConfig.track,
    });

    if (options.configuration === true) {
      await configs.load();
      // Prime the installed owner's references as its startup hook does.
      await platform.services.use(ConfigurationV1).current();
    }

    return { platform, hostConfig, credentials, configs, close };
  } catch (error) {
    await close();
    throw error;
  }
};

/**
 * The kernel over a fixture's migrated client, booted through
 * `configuration_activation`. The client stays the fixture's to close; the
 * credential key is the fixed test key unless `environment` says otherwise.
 */
export const kernelOver = (
  database: Database,
  environment: Readonly<Record<string, string | undefined>> = {
    DORIC_CREDENTIAL_KEY: credentialKey,
  },
  options: Omit<KernelOptions, 'foundation'> = {},
): Promise<Kernel> =>
  startKernel({
    configuration: true,
    ...options,
    foundation: postgresEmbedded({
      id: testFoundationId,
      database: () => database,
      environment,
    }),
  });
