import type { Bundle } from 'bundle';
import type { Logger } from 'pino';

import type { ConfigInput, ConfigUpdate, DoricConfig } from './schema.js';
import type { ConfigStore } from './store.js';
import { createGeneration, type Generation } from './generation.js';

export type ConfigService = {
  current(): Generation;
  replace(update: ConfigUpdate): Promise<DoricConfig>;
};

type ConfigServiceOptions = {
  readonly store: ConfigStore;
  readonly bundles: readonly Bundle[];
  readonly logger: Logger;
  readonly environment?: NodeJS.ProcessEnv;
  readonly buildGeneration?: typeof createGeneration;
};

/** Initializes and serializes atomic configuration-generation replacements. */
export const createConfigService = async ({
  store,
  bundles,
  logger,
  environment,
  buildGeneration = createGeneration,
}: ConfigServiceOptions): Promise<ConfigService> => {
  let active = await buildGeneration({
    snapshot: await store.load(),
    bundles,
    logger,
    environment,
  });
  let tail = Promise.resolve();

  return {
    current: () => active,
    replace(update) {
      const replacement = tail.then(async () => {
        const github = resolveGithub(
          update.github,
          active.snapshot.configuration.github,
        );
        const configuration: ConfigInput = {
          providers: update.providers,
          models: update.models,
          execution: update.execution,
          ...(github === undefined ? {} : { github }),
        };
        const candidate = await buildGeneration({
          snapshot: { configuration, revision: 0, updatedAt: '' },
          bundles,
          logger,
          environment,
        });
        const snapshot = await store.replace(configuration);
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
 * Resolves the write-only GitHub block against the stored configuration. Absent
 * means "leave it alone", `null` means "remove it", and a value means "set it",
 * so neither an older client nor an explicit removal can be confused with one
 * another. Inside a value, an absent or `null` token keeps the stored one and
 * `''` clears it. The store always receives a complete internal configuration.
 */
const resolveGithub = (
  update: ConfigUpdate['github'],
  stored: ConfigInput['github'],
): ConfigInput['github'] => {
  if (update === undefined) return stored;
  if (update === null) return undefined;

  const token = resolveToken(update.token, stored?.token);

  return {
    username: update.username,
    email: update.email,
    ...(token === undefined ? {} : { token }),
  };
};

const resolveToken = (
  requested: string | null | undefined,
  stored: string | undefined,
): string | undefined => {
  if (requested === undefined || requested === null) return stored;

  return requested === '' ? undefined : requested;
};
