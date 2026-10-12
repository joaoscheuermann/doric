import { DoricStartupV1, type Services } from 'bundle/contracts';

import type { DatabaseHandle } from './database.js';

/**
 * The start step of the PostgreSQL storage backend, run by the core's start
 * step through `storage.backend/v1.connect` (the `postgres` bundle cannot
 * register its own start hook: `hooks/v1` is provided by the core, which
 * requires this storage). It sets the `database_client` stage and connects
 * the process's one client, so a missing URL, or legacy Project and Thread
 * rows the stage-7 migration has not moved, fail the host here. An
 * unreachable database still fails at the first query, in the credential
 * stage, as before.
 */
export const connectDatabase = async (
  handle: DatabaseHandle,
  services: Pick<Services, 'use'>,
): Promise<void> => {
  const startup = services.use(DoricStartupV1);

  await startup.stage('database_client');
  await startup.log({
    level: 'info',
    fields: {},
    message: 'Initializing PostgreSQL client',
  });
  await handle.connect();
  await startup.log({
    level: 'info',
    fields: {},
    message: 'PostgreSQL client initialized',
  });
};
