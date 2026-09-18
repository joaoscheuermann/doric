import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

export const migrationDirectory = 'agents/doric/prisma/migrations';

/** Runs every release even when a dependent resource fails to close. */
export function cleanupStack() {
  const releases: (() => Promise<unknown>)[] = [];
  return {
    defer: (release: () => Promise<unknown>) => releases.push(release),
    async close() {
      const failures: unknown[] = [];
      for (const release of releases.splice(0).reverse()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Fixture cleanup failed');
    },
  };
}

type Connection = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
};
const defaults = {
  connect: (connectionString: string): Connection =>
    new pg.Client({ connectionString, connectionTimeoutMillis: 5000 }),
  migration: () =>
    readFile(
      `${migrationDirectory}/20260825000000_initial/migration.sql`,
      'utf8',
    ),
};

/** Owns only its fresh schema and connections, including partial setup failures. */
export async function persistenceFixture(
  connectionString: string,
  boundary = defaults,
) {
  const cleanup = cleanupStack();
  try {
    const schema = `persistence_${randomUUID().replaceAll('-', '')}`;
    const admin = boundary.connect(connectionString);
    cleanup.defer(() => admin.end());
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    cleanup.defer(() => admin.query(`DROP SCHEMA "${schema}" CASCADE`));
    const url = new URL(connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const sql = boundary.connect(url.toString());
    cleanup.defer(() => sql.end());
    await sql.connect();
    await sql.query(await boundary.migration());
    const client = () => {
      const database = new PrismaClient({
        adapter: new PrismaPg({ connectionString: url.toString() }, { schema }),
      });
      cleanup.defer(() => database.$disconnect());
      return database;
    };
    return { database: client(), second: client(), close: cleanup.close };
  } catch (error) {
    try {
      await cleanup.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Fixture setup and cleanup failed',
      );
    }
    throw error;
  }
}
