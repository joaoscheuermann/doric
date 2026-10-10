import type { HostPlatform } from 'bundle';
import { PostgresDatabaseV1 } from 'postgres/contracts';

/**
 * Connects the process's one PostgreSQL client through the `postgres` bundle,
 * at the host's `database_client` stage. A missing URL fails here, and so
 * does a database that holds legacy Project and Thread rows the stage-7
 * migration has not moved (X-14). An unreachable database still fails at the
 * first query, in `credential_activation`. No kernel code reads the client:
 * every record goes through `storage/v1` and `secrets/v1` (G-13).
 */
export const connectDatabase = async (
  platform: HostPlatform,
): Promise<void> => {
  await platform.services.use(PostgresDatabaseV1).connect();
};
