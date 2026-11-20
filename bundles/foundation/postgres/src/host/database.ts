import { createDatabase, type Database } from '../prisma.js';
import type { Environment } from './options.js';

/**
 * Thrown from `connect()` so the host fails at its `database_client` stage
 * (design 57 §10.2). The host's fatal record carries only the stage, as it
 * did before the bundle migration, so this text is not logged.
 */
export const unmigratedReason =
  'Legacy Project and Thread data has not been migrated; run prisma migrate deploy.';

/**
 * The host never serves an empty history over existing data: a row in the
 * legacy `project`, `thread` or `thread_event` table refuses the connection,
 * with or without the stage-7 marker. The check is the first round trip, so a
 * database that cannot answer it is left to fail at the first query, as
 * before.
 */
const refuseUnmigrated = async (database: Database): Promise<void> => {
  let legacy: boolean;

  try {
    legacy = await holdsLegacyRows(database);
  } catch {
    return;
  }

  if (legacy) {
    throw new Error(unmigratedReason);
  }
};

const holdsLegacyRows = async (database: Database): Promise<boolean> => {
  const [tables] = await database.$queryRaw<{ legacy: boolean }[]>`
    SELECT
      to_regclass('thread_event') IS NOT NULL
        AND to_regclass('thread') IS NOT NULL
        AND to_regclass('project') IS NOT NULL AS "legacy"`;

  if (tables === undefined || !tables.legacy) {
    return false;
  }

  const [rows] = await database.$queryRaw<{ legacy: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM "project")
        OR EXISTS (SELECT 1 FROM "thread")
        OR EXISTS (SELECT 1 FROM "thread_event") AS "legacy"`;

  return rows?.legacy === true;
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
