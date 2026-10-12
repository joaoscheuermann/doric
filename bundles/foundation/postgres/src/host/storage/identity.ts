import type { StorageIdentity } from 'bundle/contracts';

import type { Database } from '../../prisma.js';

/**
 * The reserved `identity` record: created with a random `hostId` and
 * `storageGeneration` 1 by the first call, and the same for every later call
 * and every instance over the same database (decision S-5).
 */
export const identity = async (
  database: Database,
): Promise<StorageIdentity> => {
  await database.$executeRaw`
    INSERT INTO "storage_meta" ("key", "value")
    VALUES (
      'identity',
      jsonb_build_object('hostId', gen_random_uuid()::text, 'storageGeneration', 1)
    )
    ON CONFLICT ("key") DO NOTHING`;

  const rows = await database.$queryRaw<{ value: string }[]>`
    SELECT "value"::text AS "value" FROM "storage_meta" WHERE "key" = 'identity'`;
  const stored = JSON.parse((rows[0] as { value: string }).value) as {
    hostId: string;
    storageGeneration: number;
  };

  return {
    hostId: stored.hostId,
    storageGeneration: stored.storageGeneration,
  };
};
