import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../prisma.js';

/** What a storage operation runs its SQL on: the client or a transaction. */
export type Sql = Pick<Database, '$queryRaw' | '$executeRaw'>;

/**
 * A commit can hold up to `maxBatch` items and waits on row-level advisory
 * locks, so it gets more time than Prisma's interactive-transaction defaults
 * (2 s to start, 5 s to finish).
 */
export const transactionOptions = {
  maxWait: 30_000,
  timeout: 120_000,
} as const;

/** A `timestamptz` as `Date.prototype.toISOString` writes it (UTC, milliseconds). */
export const isoTimestamp = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** JSON text as a database stores it; `undefined` is stored as `null`. */
export const jsonText = (value: unknown): string =>
  JSON.stringify(value) ?? 'null';

interface DriverFailure {
  readonly originalCode?: unknown;
  readonly originalMessage?: unknown;
}

const driverFailure = (error: unknown): DriverFailure | undefined => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }

  const adapter = (error.meta as { driverAdapterError?: unknown } | undefined)
    ?.driverAdapterError as { cause?: DriverFailure } | undefined;

  return adapter?.cause;
};

/**
 * Whether a raw query failed with this SQLSTATE and, when given, on this
 * constraint (named in PostgreSQL's message).
 */
export const failedWith = (
  error: unknown,
  sqlState: string,
  constraint?: string,
): boolean => {
  const failure = driverFailure(error);

  return (
    failure?.originalCode === sqlState &&
    (constraint === undefined ||
      (typeof failure.originalMessage === 'string' &&
        failure.originalMessage.includes(`"${constraint}"`)))
  );
};

/** One advisory lock a commit takes before it reads or writes. */
export interface LockRequest {
  readonly name: string;
  /** Shared locks let writers of a type run together, but not with `declareType`. */
  readonly shared: boolean;
}

// Lock names are JSON arrays, so no two resources share a name.
const lockName = (...parts: readonly string[]): string =>
  JSON.stringify(['doric.storage', ...parts]);

export const documentLock = (type: string, id: string): LockRequest => ({
  name: lockName('document', type, id),
  shared: false,
});

export const streamLock = (stream: string): LockRequest => ({
  name: lockName('stream', stream),
  shared: false,
});

export const typeLock = (type: string, shared: boolean): LockRequest => ({
  name: lockName('type', type),
  shared,
});

/**
 * Takes transaction-scoped advisory locks in one global order (by key, an
 * exclusive request winning over a shared one on the same key), so two
 * commits never wait on each other in a cycle. The locks serialize every
 * writer of a document, a stream or a type's declaration, including a
 * create that must find the document absent.
 */
export const lock = async (
  sql: Sql,
  requests: readonly LockRequest[],
): Promise<void> => {
  if (requests.length === 0) {
    return;
  }

  const names = requests.map(({ name }) => name);
  const shared = requests.map((request) => request.shared);

  await sql.$executeRaw`
    SELECT CASE
             WHEN o.shared THEN pg_advisory_xact_lock_shared(o.key)
             ELSE pg_advisory_xact_lock(o.key)
           END
    FROM (
      SELECT h.key, bool_and(h.shared) AS shared
      FROM (
        SELECT hashtextextended(u.name, 0) AS key, u.shared
        FROM unnest(${names}::text[], ${shared}::boolean[]) AS u(name, shared)
      ) h
      GROUP BY h.key
      ORDER BY h.key
    ) o`;
};

/**
 * The lock every commit takes last and holds until it commits: positions are
 * taken one commit at a time, so they become visible in commit order and the
 * feed never shows a gap that later fills in (decision S-14).
 */
export const lockPosition = async (sql: Sql): Promise<void> => {
  await sql.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName('commit')}, 0))`;
};
