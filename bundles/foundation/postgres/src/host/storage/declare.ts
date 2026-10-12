import { ContractError, type StorageDeclaration } from 'bundle/contracts';
import { encodeIndexKey, indexValues, uniqueConflict } from 'storage';

import type { Database } from '../../prisma.js';
import {
  failedWith,
  lock,
  type Sql,
  transactionOptions,
  typeLock,
} from './sql.js';

/** One declared index as the backend keeps it. */
export interface DeclaredIndex {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique: boolean;
}

const normalize = (declaration: StorageDeclaration): DeclaredIndex[] => {
  const indexes = declaration.indexes.map((index) => ({
    name: index.name,
    fields: [...index.fields],
    unique: index.unique === true,
  }));

  if (new Set(indexes.map(({ name }) => name)).size !== indexes.length) {
    throw new ContractError(
      'invalid_input',
      `Type ${declaration.type} declares an index name twice.`,
    );
  }

  return indexes;
};

/** The stored declaration, read back in a fixed key order. */
const parseIndexes = (text: string): DeclaredIndex[] =>
  (JSON.parse(text) as DeclaredIndex[]).map(({ name, fields, unique }) => ({
    name,
    fields: [...fields],
    unique,
  }));

/** The declared indexes of these types; an undeclared type has none. */
export const readDeclarations = async (
  sql: Sql,
  types: readonly string[],
): Promise<Map<string, DeclaredIndex[]>> => {
  const declared = new Map<string, DeclaredIndex[]>();

  if (types.length === 0) {
    return declared;
  }

  const rows = await sql.$queryRaw<{ type: string; indexes: string }[]>`
    SELECT "type", "indexes"::text AS "indexes"
    FROM "storage_type"
    WHERE "type" = ANY(${[...types]}::text[])`;

  for (const row of rows) {
    declared.set(row.type, parseIndexes(row.indexes));
  }

  return declared;
};

/** The key of each declared index for one value; `invalid_index_value` on a bad field. */
export const indexKeys = (
  indexes: readonly DeclaredIndex[],
  value: unknown,
): { readonly index: DeclaredIndex; readonly key: Uint8Array }[] =>
  indexes.map((index) => ({
    index,
    key: encodeIndexKey(indexValues(value, index.fields)),
  }));

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export interface EntryRow {
  readonly documentId: string;
  readonly index: DeclaredIndex;
  readonly key: Uint8Array;
}

/**
 * Inserts index entries. Entries of a unique index go in one statement per
 * index, so a key another document holds is `unique_conflict` naming it.
 */
export const insertEntries = async (
  sql: Sql,
  type: string,
  entries: readonly EntryRow[],
): Promise<void> => {
  // `null` gathers the entries of every non-unique index.
  const groups = new Map<string | null, EntryRow[]>();

  for (const entry of entries) {
    const group = entry.index.unique ? entry.index.name : null;
    const rows = groups.get(group) ?? [];

    rows.push(entry);
    groups.set(group, rows);
  }

  for (const [group, rows] of groups) {
    try {
      await sql.$executeRaw`
        INSERT INTO "storage_index_entry" ("type", "index_name", "key", "document_id", "unique_key")
        SELECT ${type}, u.index_name, decode(u.key, 'hex'), u.document_id, u.unique_key
        FROM unnest(
          ${rows.map(({ index }) => index.name)}::text[],
          ${rows.map(({ key }) => hex(key))}::text[],
          ${rows.map(({ documentId }) => documentId)}::text[],
          ${rows.map(({ index }) => index.unique)}::boolean[]
        ) AS u(index_name, key, document_id, unique_key)`;
    } catch (error) {
      if (group !== null && isUniqueViolation(error)) {
        throw uniqueConflict(type, group);
      }

      throw error;
    }
  }
};

const isUniqueViolation = (error: unknown): boolean =>
  failedWith(error, '23505', 'storage_index_entry_unique_key');

const sameIndexes = (
  left: readonly DeclaredIndex[],
  right: readonly DeclaredIndex[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Records a type's indexes. A changed declaration rebuilds the entries of
 * every stored document of the type in the same transaction; a bad value or
 * a unique violation leaves the previous declaration and its entries as they
 * were. Documents are never deleted.
 */
export const declareType = async (
  database: Database,
  declaration: StorageDeclaration,
): Promise<void> => {
  const indexes = normalize(declaration);
  const { type } = declaration;

  await database.$transaction(async (sql) => {
    await lock(sql, [typeLock(type, false)]);

    const current = (await readDeclarations(sql, [type])).get(type);

    if (current !== undefined && sameIndexes(current, indexes)) {
      return;
    }

    const documents = await sql.$queryRaw<{ id: string; value: string }[]>`
      SELECT "id", "value"::text AS "value"
      FROM "storage_document"
      WHERE "type" = ${type}`;
    const entries: EntryRow[] = [];

    for (const document of documents) {
      for (const { index, key } of indexKeys(
        indexes,
        JSON.parse(document.value),
      )) {
        entries.push({ documentId: document.id, index, key });
      }
    }

    await sql.$executeRaw`
      INSERT INTO "storage_type" ("type", "indexes", "declared_at")
      VALUES (${type}, ${JSON.stringify(indexes)}::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT ("type") DO UPDATE
      SET "indexes" = EXCLUDED."indexes", "declared_at" = EXCLUDED."declared_at"`;
    await sql.$executeRaw`
      DELETE FROM "storage_index_entry" WHERE "type" = ${type}`;
    await insertEntries(sql, type, entries);
  }, transactionOptions);
};
