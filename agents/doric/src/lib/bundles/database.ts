import type { HostPlatform } from 'bundle';
import { PostgresDatabaseV1 } from 'postgres/contracts';
import type { Database } from 'postgres/prisma';

/**
 * Opens the process's one PostgreSQL client through the `postgres` bundle. As
 * before, connecting opens no connection: a missing URL fails here, at the
 * host's `database_client` stage, while an unreachable or unmigrated database
 * fails at the first query, in `credential_activation`. The kernel stores
 * share this client until their data moves to `storage/v1`.
 */
export const connectDatabase = async (
  platform: HostPlatform,
): Promise<Database> => {
  const database = platform.services.use(PostgresDatabaseV1);

  await database.connect();

  return database.client();
};
