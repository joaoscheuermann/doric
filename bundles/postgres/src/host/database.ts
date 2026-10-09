import { createDatabase, type Database } from '../prisma.js';
import type { Environment } from './options.js';

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
      await client().$connect();
    },
    close: async () => {
      if (created !== undefined && owned) {
        await created.$disconnect();
      }
    },
  };
};
