import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { type Database, PrismaClient } from '../../src/prisma.js';

/** The PostgreSQL the database suites run against; they skip without it. */
export const connectionString = process.env.DORIC_TEST_DATABASE_URL;

export const skipWithoutDatabase =
  connectionString === undefined ? 'DORIC_TEST_DATABASE_URL is not set' : false;

export const migrationsDirectory = fileURLToPath(
  new URL('../../../prisma/migrations', import.meta.url),
);

/** The migration directories in apply order. */
export const migrationNames = async (): Promise<string[]> =>
  (await readdir(migrationsDirectory))
    .filter((entry) => entry !== 'migration_lock.toml')
    .sort();

export const migrationSql = (name: string): Promise<string> =>
  readFile(`${migrationsDirectory}/${name}/migration.sql`, 'utf8');

/** A Prisma client of the test schema, and a way to drop it ungracefully. */
export interface TestClient {
  readonly database: Database;
  /** Abandons the client: its pool ends without waiting for anything. */
  crash(): void;
}

export interface TestDatabase {
  /** The connection string of the fresh schema (its `search_path`). */
  readonly url: string;
  readonly schema: string;
  /** Raw SQL on the schema, outside any client under test. */
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
  /** Applies one migration directory. */
  migrate(name: string): Promise<void>;
  /** A new client over the schema; closed with the database. */
  client(): TestClient;
  close(): Promise<void>;
}

/**
 * A fresh schema with the migrations applied, every one by default or only
 * those before `until`. Everything it creates is dropped by `close`.
 */
export const createTestDatabase = async (
  options: { readonly until?: string } = {},
): Promise<TestDatabase> => {
  if (connectionString === undefined) {
    throw new Error('DORIC_TEST_DATABASE_URL is not set.');
  }

  const releases: (() => Promise<unknown>)[] = [];
  const close = async () => {
    const failures: unknown[] = [];

    for (const release of releases.splice(0).reverse()) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Test database cleanup failed');
    }
  };

  try {
    const schema = `postgres_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString });

    await admin.connect();
    releases.push(() => admin.end());
    await admin.query(`CREATE SCHEMA "${schema}"`);
    releases.push(() => admin.query(`DROP SCHEMA "${schema}" CASCADE`));

    const address = new URL(connectionString);

    address.searchParams.set('options', `-c search_path=${schema}`);

    const url = address.toString();
    const sql = new pg.Client({ connectionString: url });

    await sql.connect();
    releases.push(() => sql.end());

    const migrate = async (name: string) => {
      await sql.query(await migrationSql(name));
    };

    for (const name of await migrationNames()) {
      if (options.until !== undefined && name >= options.until) {
        break;
      }

      await migrate(name);
    }

    return {
      url,
      schema,
      query: async <Row>(text: string, values?: readonly unknown[]) =>
        (await sql.query(text, values as unknown[] | undefined)).rows as Row[],
      migrate,
      client: () => {
        const database = new PrismaClient({
          adapter: new PrismaPg({ connectionString: url }, { schema }),
        });
        let open = true;

        releases.push(async () => {
          if (open) {
            open = false;
            await database.$disconnect();
          }
        });

        return {
          database,
          crash: () => {
            // Nothing waits for the pool to end, as if the process died.
            open = false;
            void database.$disconnect().catch(() => undefined);
          },
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
