import type { Bundle } from 'bundle';
import type { Logger } from 'pino';

import type { CredentialKind } from '../credentials/kind.js';
import type { CredentialService } from '../credentials/service.js';
import { createMutationQueue } from '../workspace/runtime.js';
import { createGeneration, type Generation } from './generation.js';
import { readModelProperties } from './models.js';
import type { ConfigInput, DoricConfig } from './schema.js';
import { providerCredentials } from './schema.js';
import type { ConfigStore } from './store.js';
import { requireToolConfigs } from './tool-config.js';

/**
 * A configuration whose credential references are not usable. It is caller
 * input, not a host failure, so the route answers it as an invalid config.
 */
export class ConfigCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCredentialError';
  }
}

/**
 * A configuration a bundled tool cannot read: a value its declared fields make
 * mandatory is missing. Like a credential fault this is caller input, so the
 * route answers it as an invalid config rather than a host failure.
 */
export class ConfigToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigToolError';
  }
}

export interface ConfigService {
  current(): Generation;
  replace(config: ConfigInput): Promise<DoricConfig>;
}

interface ConfigServiceOptions {
  readonly store: ConfigStore;
  readonly credentials: CredentialService;
  readonly bundles: readonly Bundle[];
  readonly logger: Logger;
  readonly buildGeneration?: typeof createGeneration;
  /**
   * Reads what each provider's model catalog says about the models it lists, and
   * returns the configuration to store. Injected so a test never reaches a real
   * endpoint; the default is the host's own reader.
   */
  readonly readModels?: (configuration: ConfigInput) => Promise<ConfigInput>;
}

/** Initializes and serializes atomic configuration-generation replacements. */
export const createConfigService = async ({
  store,
  credentials,
  bundles,
  logger,
  buildGeneration = createGeneration,
  readModels,
}: ConfigServiceOptions): Promise<ConfigService> => {
  const models =
    readModels ??
    ((configuration: ConfigInput) =>
      readModelProperties(configuration, { credentials, logger }));
  let active = await buildGeneration({
    snapshot: await store.load(),
    credentials,
    bundles,
    logger,
  });
  const mutations = createMutationQueue();

  return {
    current: () => active,
    // One fixed key serializes every replacement; the queue releases in a
    // finally, so a rejected replacement does not block later requests.
    replace: (config) =>
      mutations('replace', async () => {
        requireCredentials(config, credentials);
        const filled = await models(config);
        try {
          requireToolConfigs(filled, bundles);
        } catch (error) {
          throw new ConfigToolError(
            error instanceof Error
              ? error.message
              : 'A tool configuration is invalid.',
          );
        }
        const candidate = await buildGeneration({
          snapshot: { configuration: filled, revision: 0, updatedAt: '' },
          credentials,
          bundles,
          logger,
        });
        const snapshot = await store.replace(filled);
        active = { ...candidate, snapshot };
        return snapshot;
      }),
  };
};

/**
 * Every `secret` field a provider carries names an `API_TOKEN` credential, the
 * Git identity is the `GIT` kind's alone, and the GitHub integration needs
 * another `API_TOKEN`. A reference is rejected before it is activated, so no
 * stored configuration can point at a credential of the wrong kind.
 */
const requireCredentials = (
  configuration: ConfigInput,
  credentials: CredentialService,
): void => {
  for (const provider of configuration.providers)
    for (const { field, id } of providerCredentials(provider))
      requireKind(
        credentials,
        id,
        'API_TOKEN',
        `Provider ${provider.id} ${field.key}`,
      );

  requireKind(
    credentials,
    configuration.gitCredentialId,
    'GIT',
    'The Git identity',
  );
  requireKind(
    credentials,
    configuration.githubCredentialId,
    'API_TOKEN',
    'The GitHub credential',
  );
};

const requireKind = (
  credentials: CredentialService,
  id: string | undefined,
  kind: CredentialKind,
  label: string,
): void => {
  if (id === undefined) return;

  const credential = credentials.find(id);
  if (credential === undefined)
    throw new ConfigCredentialError(
      `${label} references a credential that is not stored.`,
    );

  if (credential.kind !== kind)
    throw new ConfigCredentialError(
      `${label} must reference a ${kind} credential, not a ${credential.kind} one.`,
    );
};
