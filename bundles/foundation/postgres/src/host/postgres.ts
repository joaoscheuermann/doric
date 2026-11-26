import { createDatabaseHandle } from './database.js';
import type { PostgresOptions } from './options.js';
import { secretsBackend } from './secrets/backend.js';
import { connectDatabase } from './start.js';
import { storageBackend } from './storage/backend.js';

/** The two services of the bundle over one lazily created client. */
export interface Postgres {
  readonly storage: ReturnType<typeof storageBackend>;
  readonly secrets: ReturnType<typeof secretsBackend>;
  /** Disconnects the client when it was created here from the URL. */
  close(): Promise<void>;
}

/**
 * Builds the bundle's services. Nothing is read or opened here: the client,
 * the cipher and the environment values are taken on first use.
 */
export const createPostgres = (options: PostgresOptions = {}): Postgres => {
  const environment = options.environment ?? process.env;
  const handle = createDatabaseHandle({
    environment,
    ...(options.database === undefined ? {} : { database: options.database }),
  });

  return {
    storage: storageBackend(handle.client, {
      environment,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.statfs === undefined ? {} : { statfs: options.statfs }),
      connect: (services) => connectDatabase(handle, services),
    }),
    secrets: secretsBackend(handle.client, environment),
    close: handle.close,
  };
};
