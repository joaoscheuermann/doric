import {
  ContractError,
  type StoragePage,
  type StorageQuery,
  type StoredDocument,
} from 'bundle/contracts';
import { decodeCursor, encodeCursor, keyBounds } from 'storage';

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../prisma.js';
import { readDeclarations } from './declare.js';

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly value: string;
  readonly key: Uint8Array;
}

/**
 * One page of a declared index: equality on its leading fields, an optional
 * range on the next one, ordered by key and then by document ID bytewise,
 * with a cursor while more items follow. Values come back as stored.
 */
export const query = async (
  database: Database,
  request: StorageQuery,
): Promise<StoragePage> => {
  const index = (await readDeclarations(database, [request.type]))
    .get(request.type)
    ?.find(({ name }) => name === request.index);

  if (index === undefined) {
    throw new ContractError(
      'invalid_input',
      `Type ${request.type} has no declared index "${request.index}".`,
    );
  }

  if (
    request.equals.length > index.fields.length ||
    (request.range !== undefined &&
      request.equals.length >= index.fields.length)
  ) {
    throw new ContractError(
      'invalid_input',
      `The index "${index.name}" of ${request.type} has ${index.fields.length} fields: equality takes the leading ones and a range the next one.`,
    );
  }

  const { lower, upper } = keyBounds(request);
  const after =
    request.cursor === undefined ? undefined : decodeCursor(request.cursor);
  const descending = request.order === 'desc';
  const direction = Prisma.raw(descending ? 'DESC' : 'ASC');
  const resume =
    after === undefined
      ? Prisma.empty
      : descending
        ? Prisma.sql`AND (e."key", e."document_id") < (${after.key}, ${after.id})`
        : Prisma.sql`AND (e."key", e."document_id") > (${after.key}, ${after.id})`;
  const rows = await database.$queryRaw<Row[]>`
    SELECT d."id", d."revision", d."value"::text AS "value", e."key"
    FROM "storage_index_entry" e
    JOIN "storage_document" d ON d."type" = e."type" AND d."id" = e."document_id"
    WHERE e."type" = ${request.type}
      AND e."index_name" = ${index.name}
      AND e."key" >= ${lower}
      AND e."key" < ${upper}
      ${resume}
    ORDER BY e."key" ${direction}, e."document_id" ${direction}
    LIMIT ${request.limit + 1}`;
  const page = rows.slice(0, request.limit);
  const last = page.at(-1);

  return {
    items: page.map(
      (row): StoredDocument => ({
        type: request.type,
        id: row.id,
        revision: row.revision,
        value: JSON.parse(row.value) as unknown,
      }),
    ),
    ...(rows.length > request.limit && last !== undefined
      ? { cursor: encodeCursor({ key: last.key, id: last.id }) }
      : {}),
  };
};

/** One document as stored, or `undefined`. */
export const get = async (
  database: Database,
  key: { readonly type: string; readonly id: string },
): Promise<StoredDocument | undefined> => {
  const rows = await database.$queryRaw<{ revision: number; value: string }[]>`
    SELECT "revision", "value"::text AS "value"
    FROM "storage_document"
    WHERE "type" = ${key.type} AND "id" = ${key.id}`;
  const row = rows[0];

  return row === undefined
    ? undefined
    : {
        type: key.type,
        id: key.id,
        revision: row.revision,
        value: JSON.parse(row.value) as unknown,
      };
};
