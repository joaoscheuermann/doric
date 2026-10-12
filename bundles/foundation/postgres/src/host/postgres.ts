import type { EmbeddedBundle } from 'bundle';
import type { HostContext } from 'bundle/contracts';

import { createDatabaseHandle } from './database.js';
import { databaseService } from './database-service.js';
import type { PostgresOptions } from './options.js';
import { secretsBackend } from './secrets/backend.js';
import { connectDatabase } from './start.js';
import { storageBackend } from './storage/backend.js';

/** The three services of the bundle over one lazily created client. */
export interface Postgres {
  readonly storage: ReturnType<typeof storageBackend>;
  readonly secrets: ReturnType<typeof secretsBackend>;
  readonly database: ReturnType<typeof databaseService>;
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
    database: databaseService(handle),
    close: handle.close,
  };
};

/** The host part: provides every service and closes the client on deactivation. */
export const activatePostgres =
  (options: PostgresOptions = {}) =>
  ({ services }: HostContext) => {
    const postgres = createPostgres(options);

    services.provide(postgres.storage);
    services.provide(postgres.secrets);
    services.provide(postgres.database);

    return () => postgres.close();
  };

const contracts = [
  'storage.backend/v1',
  'secrets.backend/v1',
  'postgres.database/v1',
] as const;
const version = '1.0.0';

/**
 * The bundle as an embedded foundation, for tests that boot a host over
 * PostgreSQL without staging it. The composition must still choose it in
 * `providers` for both backends.
 */
export const postgresEmbedded = (
  options: PostgresOptions & { readonly id?: string } = {},
): EmbeddedBundle => {
  const id = options.id ?? 'postgres';

  return {
    manifest: {
      manifestVersion: 1,
      id,
      version,
      engines: { doric: '^1.0.0' },
      description: 'PostgreSQL storage and secrets backends over Prisma.',
      provides: contracts.map((contract) => `${contract}@${version}`),
      requires: [],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version },
      contracts: contracts.map((contract) => ({
        id: contract,
        version,
        kind: 'service' as const,
        environment: 'host' as const,
        cardinality: 'one' as const,
        local: contract === 'postgres.database/v1',
        schema: `schemas/${contract}.json`,
      })),
    },
    host: { activate: activatePostgres(options) },
  };
};
