import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../prisma.js';

/** One `credential` row, exactly as it is stored: `secret` is still encrypted. */
export interface StoredCredential {
  readonly id: string;
  readonly kind: 'API_TOKEN' | 'USERNAME_PASSWORD' | 'GIT';
  readonly name: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly secret: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The columns one write sets; `null` removes a column the kind forbids. */
export interface CredentialRow {
  readonly id: string;
  readonly kind: StoredCredential['kind'];
  readonly name: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly secret: string | null;
}

const columns = {
  id: true,
  kind: true,
  name: true,
  username: true,
  email: true,
  secret: true,
  createdAt: true,
  updatedAt: true,
} as const;

const knownError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

/** The only conflicting value is a name already taken by the same kind. */
export const isNameConflict = (error: unknown): boolean =>
  knownError(error, 'P2002');

/**
 * Owns the `credential` table. The references a configuration holds are not
 * checked here: they belong to the `secrets/v1` facade, which refuses to
 * delete a referenced credential before it reaches this table.
 */
export const createCredentialTable = (database: () => Database) => ({
  list: async (): Promise<readonly StoredCredential[]> =>
    database().credential.findMany({
      select: columns,
      orderBy: { name: 'asc' },
    }),

  get: async (id: string): Promise<StoredCredential | undefined> =>
    (await database().credential.findUnique({
      where: { id },
      select: columns,
    })) ?? undefined,

  /** Upsert by ID; an update never changes the stored kind. */
  put: async (row: CredentialRow): Promise<void> => {
    await database().credential.upsert({
      where: { id: row.id },
      create: row,
      update: {
        name: row.name,
        username: row.username,
        email: row.email,
        secret: row.secret,
      },
      select: { id: true },
    });
  },

  delete: async (id: string): Promise<'deleted' | 'missing'> => {
    try {
      await database().credential.delete({
        where: { id },
        select: { id: true },
      });

      return 'deleted';
    } catch (error) {
      if (knownError(error, 'P2025')) {
        return 'missing';
      }

      throw error;
    }
  },
});

export type CredentialTable = ReturnType<typeof createCredentialTable>;
