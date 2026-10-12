import {
  ContractError,
  type StreamEntry,
  type StreamPage,
  type StreamRead,
  type TruncationMark,
} from 'bundle/contracts';

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../prisma.js';
import { isoTimestamp } from './sql.js';

/**
 * Entries after `afterSequence`, the stream's counter, and the truncation
 * marks that removed entries this reader may hold
 * (`afterSequence < request.afterSequence <= atSequence`), all from one
 * statement, so from one snapshot. Reading past the counter is
 * `invalid_input`; an absent stream is at 0.
 */
export const read = async (
  database: Database,
  request: StreamRead,
): Promise<StreamPage> => {
  const rows = await database.$queryRaw<
    { last: number; entries: string; truncations: string }[]
  >`
    SELECT
      COALESCE(
        (SELECT "last_sequence" FROM "storage_stream" WHERE "stream" = ${request.stream}),
        0
      ) AS "last",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'sequence', e."sequence",
              'value', e."value",
              'createdAt', ${isoTimestamp(Prisma.sql`e."created_at"`)}
            )
            ORDER BY e."sequence"
          )
          FROM (
            SELECT "sequence", "value", "created_at"
            FROM "storage_stream_entry"
            WHERE "stream" = ${request.stream} AND "sequence" > ${request.afterSequence}
            ORDER BY "sequence"
            LIMIT ${request.limit}
          ) e
        ),
        '[]'
      )::text AS "entries",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'afterSequence', t."after_sequence",
              'atSequence', t."at_sequence"
            )
            ORDER BY t."position"
          )
          FROM "storage_truncation" t
          WHERE t."stream" = ${request.stream}
            AND t."after_sequence" < ${request.afterSequence}
            AND t."at_sequence" >= ${request.afterSequence}
        ),
        '[]'
      )::text AS "truncations"`;
  const row = rows[0] as { last: number; entries: string; truncations: string };

  if (request.afterSequence > row.last) {
    throw new ContractError(
      'invalid_input',
      `Stream ${request.stream} cannot be read after ${request.afterSequence}: its last sequence is ${row.last}.`,
      {
        stream: request.stream,
        afterSequence: request.afterSequence,
        lastSequence: row.last,
      },
    );
  }

  return {
    entries: JSON.parse(row.entries) as StreamEntry[],
    lastSequence: row.last,
    truncations: JSON.parse(row.truncations) as TruncationMark[],
  };
};
