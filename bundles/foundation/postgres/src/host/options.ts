import type { StorageCapabilities } from 'bundle/contracts';

import type { Database } from '../prisma.js';

/** What `statfs` answers about the filesystem holding persistence. */
export interface DiskMeasurement {
  readonly blocks: bigint;
  readonly bavail: bigint;
}

export interface PostgresOptions {
  /**
   * Where `DORIC_DATABASE_URL`, `DORIC_CREDENTIAL_KEY` and
   * `DORIC_STORAGE_PATH` are read, when they are first needed. Defaults to
   * `process.env`.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Builds the client instead of `DORIC_DATABASE_URL`; tests inject a fixture
   * client this way and keep closing it themselves.
   */
  readonly database?: () => Database;
  /** Measures the filesystem; `statfs(path, { bigint: true })` by default. */
  readonly statfs?: (path: string) => Promise<DiskMeasurement>;
  /** Overrides of the default storage capabilities. */
  readonly limits?: Partial<StorageCapabilities>;
}

export type Environment = Readonly<Record<string, string | undefined>>;
