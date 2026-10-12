// Public contracts of the `postgres` bundle. Browser-safe: the Prisma client
// is imported as a type only.
//
// `postgres.database/v1` is provisional (decision S-12): it hands the
// process's single Prisma client to the kernel stores until their data moves
// to `storage/v1`, and leaves with `postgres` 2.0.0.
import { type CallArg, noInput, ref } from 'bundle/contracts';
import { z } from 'zod';

import type { Database } from '../prisma.js';

export type { Database } from '../prisma.js';

export interface PostgresDatabase {
  /**
   * Creates the client when needed and connects it. Rejects when
   * `DORIC_DATABASE_URL` is missing or the database cannot be reached.
   */
  connect(call?: CallArg): Promise<void>;
  /** Local: the process's single adapter-pg Prisma client. */
  client(): Database;
}

export const PostgresDatabaseV1 = ref<PostgresDatabase>('postgres.database/v1');

export const postgresDatabaseMethods = {
  connect: { input: noInput, output: z.void() },
  client: {
    input: noInput,
    output: z.custom<Database>(
      (value) => typeof value === 'object' && value !== null,
      { message: 'Expected a Prisma client.' },
    ),
  },
} as const;
