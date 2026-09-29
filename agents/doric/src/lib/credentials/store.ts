import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../database.js';
import type { CredentialKind } from './kind.js';

/** One `credential` row, exactly as it is stored: `secret` is still encrypted. */
export interface StoredCredential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly secret: string | null;
}

/** The columns one write may set; `null` removes a column the kind forbids. */
export interface CredentialRow {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly secret: string | null;
}

export type CredentialRemoval = 'deleted' | 'missing' | 'referenced';

export interface CredentialStore {
  list(): Promise<readonly StoredCredential[]>;
  create(row: CredentialRow): Promise<StoredCredential>;
  update(
    id: string,
    row: Omit<CredentialRow, 'kind'>,
  ): Promise<StoredCredential | undefined>;
  remove(id: string): Promise<CredentialRemoval>;
}

const columns = {
  id: true,
  kind: true,
  name: true,
  username: true,
  email: true,
  secret: true,
} as const;

/** Whether any provider or the configuration still points at this credential. */
const referenced = async (database: Database, id: string): Promise<boolean> =>
  (await database.providerConfiguration.count({
    where: { credentialId: id },
  })) > 0 ||
  (await database.doricConfiguration.count({
    where: { OR: [{ gitCredentialId: id }, { githubCredentialId: id }] },
  })) > 0;

/** The only conflicting value is a name already taken by the same kind. */
export const isNameConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** Owns the `credential` table; the cipher boundary lives in the service. */
export const createCredentialStore = (database: Database): CredentialStore => ({
  list: async () =>
    database.credential.findMany({ select: columns, orderBy: { name: 'asc' } }),

  create: async (row) =>
    database.credential.create({ data: row, select: columns }),

  update: async (id, row) => {
    try {
      return await database.credential.update({
        where: { id },
        data: row,
        select: columns,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        return undefined;
      throw error;
    }
  },

  remove: async (id) => {
    if (await referenced(database, id)) return 'referenced';

    try {
      await database.credential.delete({ where: { id } });
      return 'deleted';
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      if (error.code === 'P2025') return 'missing';
      // A reference written between the check above and this delete still wins.
      if (error.code === 'P2003') return 'referenced';
      throw error;
    }
  },
});
