import type { FeedPage } from 'bundle/contracts';

import type { Database } from '../../prisma.js';

/** Commits after a position, in commit order; positions have no gaps. */
export const feed = async (
  database: Database,
  request: { readonly after: number; readonly limit: number },
): Promise<FeedPage> => {
  const rows = await database.$queryRaw<
    {
      position: bigint;
      documents: string;
      streams: string;
      truncated: string;
      dropped: string;
    }[]
  >`
    SELECT "position",
           "documents"::text AS "documents",
           "streams"::text AS "streams",
           "truncated"::text AS "truncated",
           "dropped"::text AS "dropped"
    FROM "storage_commit"
    WHERE "position" > ${request.after}
    ORDER BY "position"
    LIMIT ${request.limit}`;

  return {
    commits: rows.map((row) => ({
      position: Number(row.position),
      documents: JSON.parse(row.documents) as { type: string; id: string }[],
      streams: JSON.parse(row.streams) as string[],
      truncated: JSON.parse(row.truncated) as string[],
      dropped: JSON.parse(row.dropped) as string[],
    })),
  };
};
