import { createTestServices } from 'bundle';
import {
  type StorageBackend,
  StorageBackendV1,
  type StorageCapabilities,
} from 'bundle/contracts';

import { createPostgres } from '../../src/testing.js';
import type { TestClient, TestDatabase } from './database.js';

/** One backend instance: its own client over the shared test schema. */
export interface Instance {
  readonly backend: StorageBackend;
  readonly client: TestClient;
  dispose(): Promise<void>;
}

/**
 * Opens `storage.backend/v1` instances over one test database, each reached
 * through the real dispatcher, so every call is validated against the
 * contract's schemas. This is the PostgreSQL harness for the conformance
 * kit of `storage/conformance` (§3.3 of the stage 2–3 design): `open`,
 * `reset`, `crash` and `close`.
 */
export const postgresHarness = (database: TestDatabase) => ({
  name: 'postgres',
  open: (
    options: { readonly limits?: Partial<StorageCapabilities> } = {},
  ): Instance => {
    const client = database.client();
    const postgres = createPostgres({
      environment: {},
      database: () => client.database,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    const services = createTestServices({
      bundle: { id: 'storage-test' },
      provide: [postgres.storage],
    });

    return {
      backend: services.services.use(StorageBackendV1),
      client,
      dispose: () => services.dispose(),
    };
  },
  /** Empties every generic storage table between cases. */
  reset: async (): Promise<void> => {
    await database.query(
      'TRUNCATE "storage_truncation", "storage_stream_entry", "storage_stream", "storage_index_entry", "storage_document", "storage_type", "storage_commit", "storage_blob", "storage_meta"',
    );
  },
  /** Closes an instance gracefully. */
  close: (instance: Instance): Promise<void> => instance.dispose(),
  /** Abandons an instance without a graceful close. */
  crash: async (instance: Instance): Promise<void> => {
    instance.client.crash();
    await instance.dispose();
  },
});
