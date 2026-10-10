import { createDatabase, type Database } from '../prisma.js';
import type { Environment } from './options.js';

/** Logged before the host's fatal `database_client` stage (design 57 §10.2). */
export const unmigratedReason =
  'Legacy Project and Thread data has not been migrated; run prisma migrate deploy.';

interface LegacyState {
  readonly legacy: boolean;
  readonly migrated: boolean;
}

/**
 * The host never serves an empty history over existing data: legacy
 * `project`, `thread` or `thread_event` rows without the stage-7 marker
 * refuse the connection. The check is the first round trip, so a database
 * that cannot answer it is left to fail at the first query, as before.
 */
const refuseUnmigrated = async (database: Database): Promise<void> => {
  let state: LegacyState | undefined;

  try {
    state = await readLegacyState(database);
  } catch {
    return;
  }

  if (state.legacy && !state.migrated) {
    throw new Error(unmigratedReason);
  }
};

const readLegacyState = async (database: Database): Promise<LegacyState> => {
  const [tables] = await database.$queryRaw<
    { legacy: boolean; storage: boolean }[]
  >`
    SELECT
      to_regclass('thread_event') IS NOT NULL
        AND to_regclass('thread') IS NOT NULL
        AND to_regclass('project') IS NOT NULL AS "legacy",
      to_regclass('storage_document') IS NOT NULL AS "storage"`;

  if (tables === undefined || !tables.legacy) {
    return { legacy: false, migrated: true };
  }

  const [rows] = await database.$queryRaw<{ legacy: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM "project")
        OR EXISTS (SELECT 1 FROM "thread")
        OR EXISTS (SELECT 1 FROM "thread_event") AS "legacy"`;

  if (rows === undefined || !rows.legacy) {
    return { legacy: false, migrated: true };
  }

  if (!tables.storage) {
    return { legacy: true, migrated: false };
  }

  const [marker] = await database.$queryRaw<{ migrated: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "storage_document"
      WHERE "type" = 'runtime.migration/v1' AND "id" = 'legacy-prisma'
    ) AS "migrated"`;

  return { legacy: true, migrated: marker?.migrated === true };
};

/** The process's single Prisma client, created on first use. */
export interface DatabaseHandle {
  /** The client, created now when it does not exist yet. */
  client(): Database;
  /** Creates the client when needed and connects it. */
  connect(): Promise<void>;
  /** Disconnects the client when this handle created it from the URL. */
  close(): Promise<void>;
}

/**
 * Nothing happens until the first `client()`: activation and the build's dry
 * activation never open a database. A failed creation (a missing URL) is not
 * kept, so the next use fails the same way.
 */
export const createDatabaseHandle = (options: {
  readonly environment: Environment;
  readonly database?: () => Database;
}): DatabaseHandle => {
  let created: Database | undefined;
  let owned = false;

  const client = (): Database => {
    if (created === undefined) {
      if (options.database === undefined) {
        created = createDatabase(options.environment.DORIC_DATABASE_URL ?? '');
        owned = true;
      } else {
        created = options.database();
      }
    }

    return created;
  };

  return {
    client,
    connect: async () => {
      const database = client();

      await database.$connect();
      await refuseUnmigrated(database);
    },
    close: async () => {
      if (created !== undefined && owned) {
        await created.$disconnect();
      }
    },
  };
};
