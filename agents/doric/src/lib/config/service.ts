import type { Logger } from 'pino';

import type { Bundle } from 'bundle';

import type { CredentialKind } from '../credentials/kind.js';
import type { CredentialService } from '../credentials/service.js';
import { createGeneration, type Generation } from './generation.js';
import type { ConfigInput, DoricConfig } from './schema.js';
import { providerCredentials } from './schema.js';
import type { ConfigStore } from './store.js';

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

export type ConfigService = {
  current(): Generation;
  replace(config: ConfigInput): Promise<DoricConfig>;
};

type ConfigServiceOptions = {
  readonly store: ConfigStore;
  readonly credentials: CredentialService;
  readonly bundles: readonly Bundle[];
  readonly logger: Logger;
  readonly buildGeneration?: typeof createGeneration;
};

/** Initializes and serializes atomic configuration-generation replacements. */
export const createConfigService = async ({
  store,
  credentials,
  bundles,
  logger,
  buildGeneration = createGeneration,
}: ConfigServiceOptions): Promise<ConfigService> => {
  let active = await buildGeneration({
    snapshot: await store.load(),
    credentials,
    bundles,
    logger,
  });
  let tail = Promise.resolve();

  return {
    current: () => active,
    replace(config) {
      const replacement = tail.then(async () => {
        requireCredentials(config, credentials);
        const candidate = await buildGeneration({
          snapshot: { configuration: config, revision: 0, updatedAt: '' },
          credentials,
          bundles,
          logger,
        });
        const snapshot = await store.replace(config);
        active = { ...candidate, snapshot };
        return snapshot;
      });
      // A rejected replacement must not block later requests.
      tail = replacement.then(
        () => undefined,
        () => undefined,
      );
      return replacement;
    },
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
