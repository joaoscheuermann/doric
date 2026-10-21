-- The streamed deltas of every runtime Thread event stream
-- (`runtime.thread.events/<threadId>`) are coalesced: a run of consecutive
-- `reasoning.delta`, `text.delta`, `refusal.delta` or `tool_call.delta`
-- entries that differ only in their delta becomes its first entry, carrying
-- the run's concatenated delta and the creation time of its last entry. The
-- other entries of the run are deleted, and so is every delta that says
-- nothing: no text, or for a tool call no arguments, id or name. A
-- conversation reads the same before and after, with fewer entries.
--
-- - A run is consecutive by sequence among the entries that remain: a
--   dropped delta never interrupts it, and any other entry does. Its entries
--   share the whole envelope and event except the delta field (`delta`, or
--   `argumentsDelta` for a tool call) and `createdAt`, so one prompt, one
--   type and, for a tool call, one index, id and name.
-- - A `text.delta` run is split at its first delta that is not blank (blank
--   is JavaScript's `trim()`): the chat opens an answer on that delta and
--   drops the blank deltas before it, so they never join it.
-- - Sequences are never renumbered: the first entry keeps its own, the
--   deleted entries leave gaps, and each stream's counter stays. The stream's
--   last entry is never deleted, so the stream still ends at its counter, the
--   sequence a watch continues from: the group holding it (its run, or the
--   part of a split text run it is in) is not coalesced, and it is kept even
--   when it is an empty delta. The rest of that run is treated as any other:
--   its other empty deltas are dropped, and the blank part before a split
--   tail text run is still coalesced.
-- - Entries that are not such deltas, and every other stream, are not
--   touched.
--
-- The result is verified in the same transaction: per stream, each run
-- segment (consecutive deltas of one run key) holds the same concatenated
-- deltas in the same place; every other entry, each stream's counter and
-- last sequence are unchanged. When anything changed, the
-- `storageGeneration` of the `identity` record is incremented, which
-- discards every desktop's local history snapshots. The
-- `coalesced-thread-deltas` record of `storage_meta` marks the migration as
-- done; applied again, it does nothing and never increments twice.
--
-- This migration cannot be reversed. Back up the database before
-- `prisma migrate deploy`, and apply it with the host stopped and the
-- desktop closed.
BEGIN;

DO $$
DECLARE
  entries_before bigint;
  entries_after bigint;
  merged bigint;
  absorbed bigint;
  dropped bigint;
  generation integer;
  mismatch text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "storage_meta" WHERE "key" = 'coalesced-thread-deltas'
  ) THEN
    RETURN;
  END IF;

  -- Every runtime Thread event, with its delta and run key when it is a
  -- streamed delta. A delta of an unexpected shape (not a string, or an
  -- envelope whose type differs from its event's) is left as any other
  -- entry. The view reads the live table, so it serves before and after.
  CREATE TEMP VIEW "coalesce_entry" AS
  SELECT
    e."stream",
    e."sequence",
    e."created_at",
    e."value",
    e."value"->>'type' AS "type",
    f."field",
    CASE WHEN f."field" IS NOT NULL
      THEN COALESCE(e."value"->'event'->>f."field", '')
    END AS "delta",
    CASE WHEN f."field" IS NOT NULL
      THEN COALESCE(e."value"->'event'->>f."field", '') = ''
        AND (f."field" = 'delta' OR NOT (e."value"->'event' ?| ARRAY['id', 'name']))
    END AS "empty",
    CASE WHEN f."field" IS NOT NULL
      THEN md5(jsonb_build_array(
        e."value" - 'event' - 'createdAt',
        (e."value"->'event') - f."field" - 'createdAt'
      )::text)
    END AS "key"
  FROM "storage_stream_entry" e
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN jsonb_typeof(e."value"->'event') IS DISTINCT FROM 'object'
        OR e."value"->>'type' IS DISTINCT FROM e."value"->'event'->>'type'
        THEN NULL
      WHEN e."value"->>'type' IN ('reasoning.delta', 'text.delta', 'refusal.delta')
        AND jsonb_typeof(e."value"->'event'->'delta') = 'string'
        THEN 'delta'
      WHEN e."value"->>'type' = 'tool_call.delta'
        AND COALESCE(jsonb_typeof(e."value"->'event'->'argumentsDelta'), 'string') = 'string'
        THEN 'argumentsDelta'
    END AS "field"
  ) f
  WHERE e."stream" LIKE 'runtime.thread.events/%';

  CREATE TEMP TABLE "coalesce_before" ON COMMIT DROP AS
  SELECT
    "stream", "sequence", "created_at", "type", "field", "delta", "empty", "key",
    md5("value"::text) AS "digest"
  FROM "coalesce_entry";

  CREATE TEMP TABLE "coalesce_stream" ON COMMIT DROP AS
  SELECT
    s."stream",
    s."last_sequence",
    (
      SELECT max(x."sequence") FROM "storage_stream_entry" x
      WHERE x."stream" = s."stream"
    ) AS "tail"
  FROM "storage_stream" s;

  SELECT count(*) INTO entries_before FROM "coalesce_before";

  -- The deltas that say nothing go, unless one is a stream's last entry.
  CREATE TEMP TABLE "coalesce_empty" ON COMMIT DROP AS
  SELECT b."stream", b."sequence"
  FROM "coalesce_before" b
  JOIN "coalesce_stream" t ON t."stream" = b."stream"
  WHERE b."empty" AND b."sequence" IS DISTINCT FROM t."tail";

  -- The runs of the entries that remain, and each delta's group: its run,
  -- or for a text run the part before or from its first delta that is not
  -- blank.
  CREATE TEMP TABLE "coalesce_member" ON COMMIT DROP AS
  WITH "kept" AS (
    SELECT b.*
    FROM "coalesce_before" b
    WHERE NOT EXISTS (
      SELECT 1 FROM "coalesce_empty" d
      WHERE d."stream" = b."stream" AND d."sequence" = b."sequence"
    )
  ),
  "starts" AS (
    SELECT k.*,
      CASE
        WHEN k."key" IS NOT NULL
          AND k."key" = lag(k."key") OVER (PARTITION BY k."stream" ORDER BY k."sequence")
          THEN 0
        ELSE 1
      END AS "start"
    FROM "kept" k
  ),
  "runs" AS (
    SELECT s.*,
      sum(s."start") OVER (PARTITION BY s."stream" ORDER BY s."sequence") AS "run"
    FROM "starts" s
  )
  SELECT
    r."stream", r."sequence", r."field", r."delta", r."run",
    CASE
      WHEN r."type" = 'text.delta'
        AND r."sequence" >= min(r."sequence") FILTER (
          WHERE r."delta" !~ '^[\t\n\v\f\r    -     　﻿]*$'
        ) OVER (PARTITION BY r."stream", r."run")
        THEN 1
      ELSE 0
    END AS "part"
  FROM "runs" r
  WHERE r."key" IS NOT NULL;

  -- The groups that coalesce: more than one entry, and not the stream's tail.
  CREATE TEMP TABLE "coalesce_group" ON COMMIT DROP AS
  SELECT
    m."stream", m."run", m."part",
    min(m."field") AS "field",
    min(m."sequence") AS "leader",
    max(m."sequence") AS "last",
    string_agg(m."delta", '' ORDER BY m."sequence") AS "delta"
  FROM "coalesce_member" m
  JOIN "coalesce_stream" t ON t."stream" = m."stream"
  GROUP BY m."stream", m."run", m."part", t."tail"
  HAVING count(*) > 1 AND max(m."sequence") IS DISTINCT FROM t."tail";

  -- The first entry becomes the last one with the whole delta: the two share
  -- everything else, and the creation time is the last one's.
  UPDATE "storage_stream_entry" e
  SET
    "value" = jsonb_set(l."value", ARRAY['event', g."field"], to_jsonb(g."delta")),
    "created_at" = l."created_at"
  FROM "coalesce_group" g
  JOIN "storage_stream_entry" l
    ON l."stream" = g."stream" AND l."sequence" = g."last"
  WHERE e."stream" = g."stream" AND e."sequence" = g."leader";
  GET DIAGNOSTICS merged = ROW_COUNT;

  DELETE FROM "storage_stream_entry" e
  USING "coalesce_member" m, "coalesce_group" g
  WHERE g."stream" = m."stream" AND g."run" = m."run" AND g."part" = m."part"
    AND m."sequence" <> g."leader"
    AND e."stream" = m."stream" AND e."sequence" = m."sequence";
  GET DIAGNOSTICS absorbed = ROW_COUNT;

  DELETE FROM "storage_stream_entry" e
  USING "coalesce_empty" d
  WHERE e."stream" = d."stream" AND e."sequence" = d."sequence";
  GET DIAGNOSTICS dropped = ROW_COUNT;

  SELECT count(*) INTO entries_after FROM "coalesce_entry";

  -- Verification read before the commit. Each side is cut into segments:
  -- an entry opens a new one unless it is a delta with the same run key as
  -- the entry before it, empty deltas left out on both sides. The run
  -- segments must hold the same key and the same concatenated deltas in the
  -- same place, so a merge across two runs of one key fails here even
  -- though each key's whole text is unchanged.
  SELECT x."stream" INTO mismatch FROM (
    WITH "sides" AS (
      SELECT 'before' AS "side", "stream", "sequence", "key", "delta"
      FROM "coalesce_before" WHERE "empty" IS NOT TRUE
      UNION ALL
      SELECT 'after', "stream", "sequence", "key", "delta"
      FROM "coalesce_entry" WHERE "empty" IS NOT TRUE
    ),
    "starts" AS (
      SELECT s.*,
        CASE
          WHEN s."key" IS NOT NULL
            AND s."key" = lag(s."key") OVER (
              PARTITION BY s."side", s."stream" ORDER BY s."sequence"
            )
            THEN 0
          ELSE 1
        END AS "start"
      FROM "sides" s
    ),
    "segments" AS (
      SELECT s.*,
        sum(s."start") OVER (
          PARTITION BY s."side", s."stream" ORDER BY s."sequence"
        ) AS "segment"
      FROM "starts" s
    ),
    "texts" AS (
      SELECT "side", "stream", "segment", "key",
        md5(string_agg("delta", '' ORDER BY "sequence")) AS "text"
      FROM "segments" WHERE "key" IS NOT NULL
      GROUP BY "side", "stream", "segment", "key"
    )
    (
      SELECT "stream", "segment", "key", "text" FROM "texts" WHERE "side" = 'before'
      EXCEPT
      SELECT "stream", "segment", "key", "text" FROM "texts" WHERE "side" = 'after'
    )
    UNION ALL
    (
      SELECT "stream", "segment", "key", "text" FROM "texts" WHERE "side" = 'after'
      EXCEPT
      SELECT "stream", "segment", "key", "text" FROM "texts" WHERE "side" = 'before'
    )
  ) x
  LIMIT 1;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'The Thread delta coalescing could not be verified: deltas of %.', mismatch;
  END IF;

  -- Every entry but a group's first is as it was, and every entry that is
  -- not a delta is still there.
  SELECT x."stream" INTO mismatch FROM (
    (
      SELECT a."stream", a."sequence", md5(a."value"::text), a."created_at"
      FROM "coalesce_entry" a
      WHERE NOT EXISTS (
        SELECT 1 FROM "coalesce_group" g
        WHERE g."stream" = a."stream" AND g."leader" = a."sequence"
      )
      EXCEPT
      SELECT "stream", "sequence", "digest", "created_at" FROM "coalesce_before"
    )
    UNION ALL
    (
      SELECT "stream", "sequence", "digest", "created_at"
      FROM "coalesce_before" WHERE "field" IS NULL
      EXCEPT
      SELECT "stream", "sequence", md5("value"::text), "created_at"
      FROM "coalesce_entry" WHERE "field" IS NULL
    )
  ) x
  LIMIT 1;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'The Thread delta coalescing could not be verified: entries of %.', mismatch;
  END IF;

  SELECT t."stream" INTO mismatch
  FROM "coalesce_stream" t
  LEFT JOIN "storage_stream" s ON s."stream" = t."stream"
  WHERE s."last_sequence" IS DISTINCT FROM t."last_sequence"
    OR (
      SELECT max(x."sequence") FROM "storage_stream_entry" x
      WHERE x."stream" = t."stream"
    ) IS DISTINCT FROM t."tail"
  LIMIT 1;

  IF mismatch IS NOT NULL
    OR (SELECT count(*) FROM "storage_stream") <> (SELECT count(*) FROM "coalesce_stream")
  THEN
    RAISE EXCEPTION 'The Thread delta coalescing could not be verified: stream %.', mismatch;
  END IF;

  -- A changed log invalidates the snapshots desktops keep of it.
  IF merged + absorbed + dropped > 0 THEN
    UPDATE "storage_meta"
    SET "value" = jsonb_set(
      "value",
      '{storageGeneration}',
      to_jsonb(("value"->>'storageGeneration')::integer + 1)
    )
    WHERE "key" = 'identity'
    RETURNING ("value"->>'storageGeneration')::integer INTO generation;
  END IF;

  INSERT INTO "storage_meta" ("key", "value")
  VALUES (
    'coalesced-thread-deltas',
    jsonb_build_object(
      'completedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'entriesBefore', entries_before,
      'entriesAfter', entries_after,
      'coalesced', merged,
      'absorbed', absorbed,
      'droppedEmpty', dropped,
      'storageGeneration', generation
    )
  );

  DROP VIEW "coalesce_entry";
END $$;

COMMIT;
