import { type HostContext, LogV1, ModelsProviderV1 } from 'bundle/contracts';
import { type HttpTransport, type ProviderKindId, providerKind } from 'llms';
import type { Logger } from 'pino';

import { logV1Logger } from './logger.js';
import { createKindProvider } from './provider.js';

export interface ModelsAdapterOptions {
  /** The transport of every request; a fetch transport per use by default. */
  readonly transport?: () => HttpTransport;
  /** The llms logger; by default a pino logger whose records go to `log/v1`. */
  readonly logger?: Logger;
}

/** The llms kinds, in the order llms declares them (`supportedKinds`). */
const kindIds: readonly ProviderKindId[] = ['openai', 'openrouter', 'codex'];

/**
 * The adapter's host part with its options, for tests that inject a transport
 * or a logger. It provides one `models.provider/v1` record per llms kind, in
 * the llms kind order (`openai`, `openrouter`, `codex`).
 */
export const createActivate =
  (options: ModelsAdapterOptions = {}) =>
  ({ services }: HostContext): void => {
    let logger = options.logger;
    const log = () => {
      logger ??= logV1Logger(services.use(LogV1));

      return logger;
    };

    for (const id of kindIds) {
      const kind = providerKind(id);

      if (kind !== undefined) {
        services.provide(
          createKindProvider(ModelsProviderV1, kind, {
            logger: log,
            ...(options.transport === undefined
              ? {}
              : { transport: options.transport }),
          }),
        );
      }
    }
  };

/** Provides the llms provider kinds as `models.provider/v1` records. */
export const activate = createActivate();
