// `postgres/prisma` (Node, provisional): the generated Prisma client and the
// one way to build the process's client. Only the kernel stores import it,
// until their data moves to `storage/v1` (decision S-12).
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export type Database = PrismaClient;

/** Creates the process-owned Prisma client over PostgreSQL's native pool. */
export const createDatabase = (connectionString: string): Database => {
  if (connectionString.trim().length === 0) {
    throw new Error('DORIC_DATABASE_URL is required.');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
};
