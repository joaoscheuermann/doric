import { type HostContext, LogV1 } from 'bundle/contracts';
import type { HttpTransport } from 'llms';
import type { Logger } from 'pino';

import { openRouterKind } from './kind.js';
import { logV1Logger } from './logger.js';
import { createKindProvider } from './provider.js';

export interface ProviderBundleOptions {
  /** The transport of every request; a fetch transport per use by default. */
  readonly transport?: () => HttpTransport;
  /** The llms logger; by default a pino logger whose records go to `log/v1`. */
  readonly logger?: Logger;
}

/** The host part with its options, for tests that inject a transport or a logger. */
export const createActivate =
  (options: ProviderBundleOptions = {}) =>
  ({ services }: HostContext): void => {
    let logger = options.logger;

    services.provide(
      createKindProvider(openRouterKind, {
        logger: () => {
          logger ??= logV1Logger(services.use(LogV1));

          return logger;
        },
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
      }),
    );
  };

/** Provides the `openrouter` provider kind as a `models.provider/v1` record. */
export const activate = createActivate();
