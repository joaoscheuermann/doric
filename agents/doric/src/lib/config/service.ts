import type { Bundle } from 'bundle';
import type { Logger } from 'pino';

import type { ConfigInput, DoricConfig } from './schema.js';
import type { ConfigStore } from './store.js';
import { createGeneration, type Generation } from './generation.js';

export type ConfigService = {
  current(): Generation;
  replace(config: ConfigInput): Promise<DoricConfig>;
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
    replace(config) {
      const replacement = tail.then(async () => {
        const candidate = await buildGeneration({
          snapshot: { configuration: config, revision: 0, updatedAt: '' },
          bundles,
          logger,
          environment,
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
