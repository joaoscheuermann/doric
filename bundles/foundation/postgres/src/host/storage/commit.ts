import {
  type CommitBatch,
  ContractError,
  type StorageCapabilities,
} from 'bundle/contracts';
import { checkBatchLimits, revisionConflict, sequenceConflict } from 'storage';

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../prisma.js';
import {
  type EntryRow,
  indexKeys,
  insertEntries,
  readDeclarations,
} from './declare.js';
import {
  documentLock,
  isoTimestamp,
  jsonText,
  type LockRequest,
  lock,
  lockPosition,
  type Sql,
  streamLock,
  transactionOptions,
  typeLock,
} from './sql.js';

interface DocumentKey {
  readonly type: string;
  readonly id: string;
}

const keyOf = ({ type, id }: DocumentKey): string => JSON.stringify([type, id]);

const unique = <T>(values: readonly T[], keyOfValue: (value: T) => string) => {
  const seen = new Set<string>();

  return values.filter((value) => {
    const key = keyOfValue(value);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

/** The database clock, read once per commit after its locks are held. */
const clock = async (sql: Sql): Promise<string> => {
  const rows = await sql.$queryRaw<{ now: string }[]>`
    SELECT ${isoTimestamp(Prisma.sql`date_trunc('milliseconds', clock_timestamp())`)} AS "now"`;

  return (rows[0] as { now: string }).now;
};

/** Taken under the position lock: one more than the last commit. */
const nextPosition = async (sql: Sql): Promise<bigint> => {
  const rows = await sql.$queryRaw<{ position: bigint }[]>`
    SELECT COALESCE(MAX("position"), 0) + 1 AS "position" FROM "storage_commit"`;

  return (rows[0] as { position: bigint }).position;
};

/** Every lock the batch needs, taken together before anything is read. */
const locksOf = (batch: CommitBatch): LockRequest[] => {
  const writes = [...(batch.delete ?? []), ...(batch.put ?? [])];

  return [
    ...[...(batch.expect ?? []), ...writes].map(({ type, id }) =>
      documentLock(type, id),
    ),
    // Index entries follow the declaration, which declareType changes alone.
    ...writes.map(({ type }) => typeLock(type, true)),
    ...[
      ...(batch.dropStreams ?? []),
      ...(batch.truncate === undefined ? [] : [batch.truncate.stream]),
      ...(batch.append ?? []).map(({ stream }) => stream),
    ].map(streamLock),
  ];
};

const checkExpectations = async (
  sql: Sql,
  expected: NonNullable<CommitBatch['expect']>,
): Promise<void> => {
  const rows = await sql.$queryRaw<
    { type: string; id: string; revision: number }[]
  >`
    SELECT d."type", d."id", d."revision"
    FROM "storage_document" d
    JOIN unnest(
      ${expected.map(({ type }) => type)}::text[],
      ${expected.map(({ id }) => id)}::text[]
    ) AS u("type", "id") ON d."type" = u."type" AND d."id" = u."id"`;
  const revisions = new Map(rows.map((row) => [keyOf(row), row.revision]));

  for (const entry of expected) {
    const actual = revisions.get(keyOf(entry)) ?? 0;

    if (actual !== entry.revision) {
      throw revisionConflict(entry, entry.revision, actual);
    }
  }
};

const deleteDocuments = async (
  sql: Sql,
  keys: readonly DocumentKey[],
): Promise<void> => {
  // Index entries go with their document (ON DELETE CASCADE).
  await sql.$executeRaw`
    DELETE FROM "storage_document" d
    USING unnest(
      ${keys.map(({ type }) => type)}::text[],
      ${keys.map(({ id }) => id)}::text[]
    ) AS u("type", "id")
    WHERE d."type" = u."type" AND d."id" = u."id"`;
};

/**
 * Puts in batch order, one at a time, as the protocol requires: each put
 * raises the revision by one and replaces the document's index entries
 * under the type's current declaration, and a unique index is checked at
 * each put, like a non-deferred PostgreSQL unique index.
 */
const putDocuments = async (
  sql: Sql,
  puts: NonNullable<CommitBatch['put']>,
  now: string,
): Promise<void> => {
  const declarations = await readDeclarations(sql, [
    ...new Set(puts.map(({ type }) => type)),
  ]);

  for (const { type, id, value } of puts) {
    const text = jsonText(value);
    const entries: EntryRow[] = indexKeys(
      declarations.get(type) ?? [],
      JSON.parse(text),
    ).map(({ index, key }) => ({ documentId: id, index, key }));

    await sql.$executeRaw`
      INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
      VALUES (${type}, ${id}, 1, ${text}::jsonb, ${now}::timestamptz)
      ON CONFLICT ("type", "id") DO UPDATE
      SET "revision" = "storage_document"."revision" + 1,
          "value" = EXCLUDED."value",
          "updated_at" = EXCLUDED."updated_at"`;
    await sql.$executeRaw`
      DELETE FROM "storage_index_entry"
      WHERE "type" = ${type} AND "document_id" = ${id}`;
    await insertEntries(sql, type, entries);
  }
};

/** The streams the batch writes, with the counter each one is at now. */
class Streams {
  readonly #sql: Sql;
  readonly #last = new Map<string, number>();

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /** Creates absent streams at sequence 0 and reads their counters. */
  async open(streams: readonly string[]): Promise<void> {
    const missing = [...new Set(streams)].filter(
      (stream) => !this.#last.has(stream),
    );

    if (missing.length === 0) {
      return;
    }

    await this.#sql.$executeRaw`
      INSERT INTO "storage_stream" ("stream", "last_sequence")
      SELECT u.stream, 0 FROM unnest(${missing}::text[]) AS u(stream)
      ON CONFLICT ("stream") DO NOTHING`;

    const rows = await this.#sql.$queryRaw<{ stream: string; last: number }[]>`
      SELECT "stream", "last_sequence" AS "last"
      FROM "storage_stream"
      WHERE "stream" = ANY(${missing}::text[])`;

    for (const row of rows) {
      this.#last.set(row.stream, row.last);
    }
  }

  forget(stream: string): void {
    this.#last.delete(stream);
  }

  last(stream: string): number {
    return this.#last.get(stream) ?? 0;
  }

  advance(stream: string, last: number): void {
    this.#last.set(stream, last);
  }
}

const dropStreams = async (
  sql: Sql,
  streams: Streams,
  dropped: readonly string[],
): Promise<void> => {
  // Entries and truncation marks go with their stream (ON DELETE CASCADE).
  await sql.$executeRaw`
    DELETE FROM "storage_stream" WHERE "stream" = ANY(${[...dropped]}::text[])`;

  for (const stream of dropped) {
    streams.forget(stream);
  }
};

const truncate = async (
  sql: Sql,
  streams: Streams,
  { stream, afterSequence }: NonNullable<CommitBatch['truncate']>,
): Promise<void> => {
  await streams.open([stream]);

  const last = streams.last(stream);

  if (afterSequence > last) {
    throw new ContractError(
      'invalid_input',
      `Stream ${stream} cannot be truncated after ${afterSequence}: its last sequence is ${last}.`,
      { stream, afterSequence, lastSequence: last },
    );
  }

  await sql.$executeRaw`
    DELETE FROM "storage_stream_entry"
    WHERE "stream" = ${stream} AND "sequence" > ${afterSequence}`;
};

const append = async (
  sql: Sql,
  streams: Streams,
  appends: NonNullable<CommitBatch['append']>,
  now: string,
): Promise<string[]> => {
  await streams.open(appends.map(({ stream }) => stream));

  const rows: { stream: string; sequence: number; value: string }[] = [];

  for (const entry of appends) {
    let last = streams.last(entry.stream);

    if (
      entry.expectedSequence !== undefined &&
      entry.expectedSequence !== last
    ) {
      throw sequenceConflict(entry.stream, entry.expectedSequence, last);
    }

    for (const event of entry.events) {
      last += 1;
      rows.push({
        stream: entry.stream,
        sequence: last,
        value: jsonText(event),
      });
    }

    streams.advance(entry.stream, last);
  }

  await sql.$executeRaw`
    INSERT INTO "storage_stream_entry" ("stream", "sequence", "value", "created_at")
    SELECT u.stream, u.sequence, u.value::jsonb, ${now}::timestamptz
    FROM unnest(
      ${rows.map(({ stream }) => stream)}::text[],
      ${rows.map(({ sequence }) => sequence)}::integer[],
      ${rows.map(({ value }) => value)}::text[]
    ) AS u(stream, sequence, value)`;

  const touched = unique(
    appends.map(({ stream }) => stream),
    (stream) => stream,
  );

  await sql.$executeRaw`
    UPDATE "storage_stream" s
    SET "last_sequence" = u.last
    FROM unnest(
      ${touched}::text[],
      ${touched.map((stream) => streams.last(stream))}::integer[]
    ) AS u(stream, last)
    WHERE s."stream" = u.stream`;

  return touched;
};

/**
 * One atomic batch, applied in the normative order
 * expect → delete → put → dropStreams → truncate → append, or not at all.
 * A failed batch leaves no document, index entry, stream entry, truncation
 * mark or feed entry behind, and takes no position.
 */
export const commit = async (
  database: Database,
  batch: CommitBatch,
  limits: StorageCapabilities,
): Promise<{ position: number }> => {
  // Refused before anything is sent.
  checkBatchLimits(batch, limits);

  return await database.$transaction(async (sql) => {
    await lock(sql, locksOf(batch));

    const now = await clock(sql);
    const streams = new Streams(sql);

    if (batch.expect !== undefined && batch.expect.length > 0) {
      await checkExpectations(sql, batch.expect);
    }

    if (batch.delete !== undefined && batch.delete.length > 0) {
      await deleteDocuments(sql, batch.delete);
    }

    if (batch.put !== undefined && batch.put.length > 0) {
      await putDocuments(sql, batch.put, now);
    }

    if (batch.dropStreams !== undefined && batch.dropStreams.length > 0) {
      await dropStreams(sql, streams, batch.dropStreams);
    }

    if (batch.truncate !== undefined) {
      await truncate(sql, streams, batch.truncate);
    }

    const appended =
      batch.append !== undefined && batch.append.length > 0
        ? await append(sql, streams, batch.append, now)
        : [];

    await lockPosition(sql);

    const position = await nextPosition(sql);
    const documents = unique(
      [...(batch.delete ?? []), ...(batch.put ?? [])].map(({ type, id }) => ({
        type,
        id,
      })),
      keyOf,
    );

    await sql.$executeRaw`
      INSERT INTO "storage_commit" ("position", "documents", "streams", "truncated", "dropped", "committed_at")
      VALUES (
        ${position},
        ${JSON.stringify(documents)}::jsonb,
        ${JSON.stringify(appended)}::jsonb,
        ${JSON.stringify(batch.truncate === undefined ? [] : [batch.truncate.stream])}::jsonb,
        ${JSON.stringify(unique(batch.dropStreams ?? [], (stream) => stream))}::jsonb,
        ${now}::timestamptz
      )`;

    if (batch.truncate !== undefined) {
      // The mark records the counter at the end of the batch, appends of the
      // same batch included, so a reader holding the removed tail sees it.
      await sql.$executeRaw`
        INSERT INTO "storage_truncation" ("stream", "position", "after_sequence", "at_sequence")
        VALUES (
          ${batch.truncate.stream},
          ${position},
          ${batch.truncate.afterSequence},
          ${streams.last(batch.truncate.stream)}
        )`;
    }

    return { position: Number(position) };
  }, transactionOptions);
};
