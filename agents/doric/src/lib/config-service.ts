import type { Logger } from 'pino';

import type { Bundle } from 'bundle';

import type { ConfigInput, DoricConfig } from './config.js';
import type { ConfigStore } from './config-store.js';
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

  const exclusive = async <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = tail;
    let release: () => void = () => undefined;

    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    current: () => active,
    replace: (config) =>
      exclusive(async () => {
        const candidate = await buildGeneration({
          snapshot: { configuration: config, revision: 0, updatedAt: '' },
          bundles,
          logger,
          environment,
        });
        const snapshot = await store.replace(config);

        active = { ...candidate, snapshot };

        return snapshot;
      }),
  };
};
