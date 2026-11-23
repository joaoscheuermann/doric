import test from 'node:test';

import type { Client } from '@connectrpc/connect';
import type {
  SecretsBackend,
  StorageBackend,
  StorageCapabilities,
} from 'bundle/contracts';
import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import type { HostContext } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import type { ConformanceHarness } from 'storage/conformance';
import {
  secretsBackendClient,
  serveSecretsBackend,
  serveStorageBackend,
  storageBackendClient,
} from 'storage/rpc';

import {
  createPostgresBackends,
  type PostgresBackends,
} from '../../src/testing.js';
import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestClient,
  type TestDatabase,
} from './database.js';

/** The bundle's two backends served as `main.ts` serves them, on one test router. */
export interface RoutedPostgres {
  /** `storageBackendClient` over the router's client. */
  readonly storage: StorageBackend;
  /** `secretsBackendClient` over the router's client. */
  readonly secrets: SecretsBackend;
  /** The raw Connect clients, for wire-shape assertions. */
  readonly raw: {
    readonly storage: Client<typeof StorageBackendService>;
    readonly secrets: Client<typeof SecretsBackendService>;
  };
  readonly backends: PostgresBackends;
  /** What `connect` wrote through the context's log (`router.logs`). */
  readonly logs: readonly { readonly level: string; readonly message: string }[];
  /** Stops the router and closes the backends. */
  dispose(): Promise<void>;
}

/**
 * `createPostgresBackends({ environment, database, limits, log })` served with
 * `[StorageBackendService, serveStorageBackend(...)]` and
 * `[SecretsBackendService, serveSecretsBackend(...)]` on a fresh
 * `createTestRouter()`, activated with an `activate` that keeps the context
 * for the log, as `main.ts` does. `environment` defaults to `{}`.
 */
export const servePostgres = async (options: {
  readonly database?: () => TestClient['database'];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly limits?: Partial<StorageCapabilities>;
}): Promise<RoutedPostgres> => {
  let context: HostContext | undefined;
  const backends = createPostgresBackends({
    environment: options.environment ?? {},
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    log: { info: (message, fields) => context?.log.info(message, fields) },
  });
  const router = createTestRouter();

  await router.activate({
    services: [
      [StorageBackendService, serveStorageBackend(backends.storage)],
      [SecretsBackendService, serveSecretsBackend(backends.secrets)],
    ],
    activate: (activated) => {
      context = activated;
    },
  });

  const raw = {
    storage: router.client(StorageBackendService),
    secrets: router.client(SecretsBackendService),
  };

  return {
    storage: storageBackendClient(raw.storage),
    secrets: secretsBackendClient(raw.secrets),
    raw,
    backends,
    logs: router.logs,
    dispose: async () => {
      await router.control.stop();
      await backends.close();
    },
  };
};

export interface RoutedContext {
  readonly database: TestDatabase;
  /**
   * Another `servePostgres` over its own client of the same schema, with
   * `environment`; disposed after the test.
   */
  serve(
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<RoutedPostgres>;
}

/**
 * A test over a fresh schema (migrated up to `until`, every migration by
 * default), given `serve` to open routed instances over it. Skipped without
 * DORIC_TEST_DATABASE_URL. Everything opened is disposed, then the schema is
 * dropped.
 */
export const routedTest = (
  name: string,
  run: (context: RoutedContext) => Promise<void>,
  options: { readonly until?: string } = {},
): void => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase(
      options.until === undefined ? {} : { until: options.until },
    );
    const opened: RoutedPostgres[] = [];

    try {
      await run({
        database,
        serve: async (environment = {}) => {
          const client = database.client();
          const served = await servePostgres({
            database: () => client.database,
            environment,
          });

          opened.push(served);

          return served;
        },
      });
    } finally {
      for (const served of opened.reverse()) {
        await served.dispose();
      }

      await database.close();
    }
  });
};

/** One conformance instance: the router over its own client. */
export interface RouterInstance {
  readonly backend: StorageBackend;
  readonly client: TestClient;
  dispose(): Promise<void>;
}

/**
 * The conformance harness over the router on one migrated test schema. Each
 * `open` gets its own client and its own `servePostgres`; `reset` truncates
 * the generic storage tables (as `postgresHarness.reset`); `crash` abandons
 * the client and then disposes; `close` disposes and disconnects. Name
 * `postgres over router`.
 */
export const postgresRouterHarness = (
  database: TestDatabase,
): ConformanceHarness<RouterInstance> => ({
  name: 'postgres over router',
  open: async (options = {}) => {
    const client = database.client();
    const served = await servePostgres({
      database: () => client.database,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });

    return { backend: served.storage, client, dispose: served.dispose };
  },
  reset: async () => {
    await database.query(
      'TRUNCATE "storage_truncation", "storage_stream_entry", "storage_stream", "storage_index_entry", "storage_document", "storage_type", "storage_commit", "storage_blob", "storage_meta"',
    );
  },
  crash: async (instance) => {
    instance.client.crash();
    await instance.dispose();
  },
  close: async (instance) => {
    await instance.dispose();
    await instance.client.database.$disconnect();
  },
});
