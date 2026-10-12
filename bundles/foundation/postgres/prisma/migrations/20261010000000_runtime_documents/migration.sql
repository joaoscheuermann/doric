-- Stage 7: the Projects, Threads, histories and event logs move from the
-- `project`, `thread` and `thread_event` tables into the generic storage
-- (`storage/v1`) types and streams of the `runtime` bundle:
--
-- - `runtime.project/v1` `<id>` and `runtime.thread/v1` `<id>` documents;
-- - `runtime.history/v1` `<threadId>:messages` and `<threadId>:meta`;
-- - one `runtime.thread.events/<threadId>` stream per Thread, entries keeping
--   their sequence (gaps included), payload and creation time, and the
--   counter keeping `last_sequence`.
--
-- No `storage_type` or `storage_index_entry` row is written: the runtime's
-- first `declareType` of each type finds no stored declaration and builds the
-- index entries of the imported documents, so the key encoding lives only in
-- `packages/storage`.
--
-- The copy is verified in the same transaction before the switch, which
-- records the `runtime.migration/v1 legacy-prisma` marker (with one
-- `storage_commit` naming it) and deletes the legacy rows. Applied again, it
-- does nothing.
--
-- This migration cannot be reversed. Back up the database before
-- `prisma migrate deploy`.
BEGIN;

DO $$
DECLARE
  legacy_projects bigint;
  legacy_threads bigint;
  legacy_events bigint;
  mismatch text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "storage_document"
    WHERE "type" = 'runtime.migration/v1' AND "id" = 'legacy-prisma'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO legacy_projects FROM "project";
  SELECT count(*) INTO legacy_threads FROM "thread";
  SELECT count(*) INTO legacy_events FROM "thread_event";

  -- Projects.
  INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
  SELECT
    'runtime.project/v1',
    p."id"::text,
    1,
    jsonb_build_object(
      'id', p."id"::text,
      'name', p."name",
      'color', p."color",
      'state', lower(p."state"::text),
      'open', p."state"::text NOT IN ('FAILED', 'CANCELLED'),
      'configRevision', p."config_revision",
      'configSnapshot', p."config_snapshot",
      'errorCode', p."error_code",
      'createdAt', to_char(p."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(p."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'startedAt', to_char(p."started_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'finishedAt', to_char(p."finished_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'createdKey', to_char(p."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || p."id"::text
    ),
    p."updated_at"
  FROM "project" p
  ON CONFLICT DO NOTHING;

  -- Threads. `pending` is null so the runtime folds it lazily from the
  -- stream; a null `usage` stays null and is derived lazily, as today.
  INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
  SELECT
    'runtime.thread/v1',
    t."id"::text,
    1,
    jsonb_build_object(
      'id', t."id"::text,
      'projectId', t."project_id"::text,
      'parentThreadId', t."parent_thread_id"::text,
      'name', t."name",
      'state', lower(t."state"::text),
      'open', t."state"::text NOT IN ('FAILED', 'CANCELLED'),
      'cwd', t."cwd",
      'cwdRepo', t."cwd_repo",
      'queuePaused', t."queue_paused",
      'activePromptId', t."active_prompt_id"::text,
      'errorCode', t."error_code",
      'lastSequence', t."last_sequence",
      'result',
        CASE
          WHEN t."result_status" IS NOT NULL AND t."result_text" IS NOT NULL
            AND t."result_prompt_id" IS NOT NULL AND t."result_at" IS NOT NULL
            THEN jsonb_build_object(
              'status', t."result_status",
              'text', t."result_text",
              'promptId', t."result_prompt_id"::text,
              'at', to_char(t."result_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          ELSE NULL
        END,
      'lastStarted',
        CASE
          WHEN s."prompt_id" IS NULL THEN NULL
          ELSE jsonb_build_object(
            'promptId', s."prompt_id"::text,
            'at', to_char(s."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        END,
      'usage', t."usage",
      'pending', NULL,
      'createdAt', to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(t."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'startedAt', to_char(t."started_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'finishedAt', to_char(t."finished_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'createdKey', to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || t."id"::text
    ),
    t."updated_at"
  FROM "thread" t
  LEFT JOIN (
    SELECT DISTINCT ON ("thread_id") "thread_id", "prompt_id", "created_at"
    FROM "thread_event"
    WHERE "type" = 'prompt.started'
    ORDER BY "thread_id", "sequence" DESC
  ) s ON s."thread_id" = t."id"
  ON CONFLICT DO NOTHING;

  -- Executor histories: the provider messages verbatim, and the checkpoints
  -- with the message count they are measured against.
  INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
  SELECT
    'runtime.history/v1',
    t."id"::text || ':messages',
    1,
    jsonb_build_object(
      'threadId', t."id"::text,
      'projectId', t."project_id"::text,
      'format', 'direct.history/v1',
      'part', 'messages',
      'value', t."messages"
    ),
    t."updated_at"
  FROM "thread" t
  ON CONFLICT DO NOTHING;

  INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
  SELECT
    'runtime.history/v1',
    t."id"::text || ':meta',
    1,
    jsonb_build_object(
      'threadId', t."id"::text,
      'projectId', t."project_id"::text,
      'format', 'direct.history/v1',
      'part', 'meta',
      'value', jsonb_build_object(
        'checkpoints', t."checkpoints",
        'messageCount', jsonb_array_length(t."messages")
      )
    ),
    t."updated_at"
  FROM "thread" t
  ON CONFLICT DO NOTHING;

  -- Event streams: the counter of every Thread, and its existing entries
  -- only, so the gaps left by rewinds stay.
  INSERT INTO "storage_stream" ("stream", "last_sequence")
  SELECT 'runtime.thread.events/' || t."id"::text, t."last_sequence"
  FROM "thread" t
  ON CONFLICT DO NOTHING;

  INSERT INTO "storage_stream_entry" ("stream", "sequence", "value", "created_at")
  SELECT
    'runtime.thread.events/' || e."thread_id"::text,
    e."sequence",
    jsonb_build_object(
      'projectId', e."project_id"::text,
      'threadId', e."thread_id"::text,
      'promptId', e."prompt_id"::text,
      'type', e."type",
      'event', e."event"
    ),
    e."created_at"
  FROM "thread_event" e
  ON CONFLICT DO NOTHING;

  -- Verification read before the switch.
  IF (SELECT count(*) FROM "storage_document" WHERE "type" = 'runtime.project/v1') <> legacy_projects
    OR (SELECT count(*) FROM "storage_document" WHERE "type" = 'runtime.thread/v1') <> legacy_threads
    OR (SELECT count(*) FROM "storage_document" WHERE "type" = 'runtime.history/v1') <> 2 * legacy_threads
    OR (
      SELECT count(*) FROM "storage_stream_entry"
      WHERE "stream" LIKE 'runtime.thread.events/%'
    ) <> legacy_events
  THEN
    RAISE EXCEPTION 'The Project and Thread migration could not be verified: counts differ.';
  END IF;

  SELECT p."id"::text INTO mismatch
  FROM "project" p
  LEFT JOIN "storage_document" d
    ON d."type" = 'runtime.project/v1' AND d."id" = p."id"::text
  WHERE d."id" IS NULL
    OR (d."value"->'configSnapshot')::text IS DISTINCT FROM p."config_snapshot"::text
  LIMIT 1;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'The Project and Thread migration could not be verified: Project %.', mismatch;
  END IF;

  SELECT t."id"::text INTO mismatch
  FROM "thread" t
  LEFT JOIN "storage_document" d
    ON d."type" = 'runtime.thread/v1' AND d."id" = t."id"::text
  LEFT JOIN "storage_document" m
    ON m."type" = 'runtime.history/v1' AND m."id" = t."id"::text || ':messages'
  LEFT JOIN "storage_document" c
    ON c."type" = 'runtime.history/v1' AND c."id" = t."id"::text || ':meta'
  LEFT JOIN "storage_stream" s
    ON s."stream" = 'runtime.thread.events/' || t."id"::text
  WHERE d."id" IS NULL
    OR (m."value"->'value')::text IS DISTINCT FROM t."messages"::text
    OR (c."value"->'value'->'checkpoints')::text IS DISTINCT FROM t."checkpoints"::text
    OR s."last_sequence" IS DISTINCT FROM t."last_sequence"
    OR (
      SELECT md5(COALESCE(string_agg(e."sequence"::text || ':' || e."event"::text, ',' ORDER BY e."sequence"), ''))
      FROM "thread_event" e
      WHERE e."thread_id" = t."id"
    ) IS DISTINCT FROM (
      SELECT md5(COALESCE(string_agg(x."sequence"::text || ':' || (x."value"->'event')::text, ',' ORDER BY x."sequence"), ''))
      FROM "storage_stream_entry" x
      WHERE x."stream" = 'runtime.thread.events/' || t."id"::text
    )
  LIMIT 1;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'The Project and Thread migration could not be verified: Thread %.', mismatch;
  END IF;

  -- Switch: the marker, the commit that names it, then the legacy rows go,
  -- so no Project deleted through the new storage leaves its events behind.
  INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
  VALUES (
    'runtime.migration/v1',
    'legacy-prisma',
    1,
    jsonb_build_object(
      'source', 'prisma-legacy',
      'completedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'counts', jsonb_build_object(
        'projects', legacy_projects,
        'threads', legacy_threads,
        'events', legacy_events,
        'histories', 2 * legacy_threads
      )
    ),
    CURRENT_TIMESTAMP
  );

  INSERT INTO "storage_commit" ("position", "documents", "streams")
  SELECT
    COALESCE(max("position"), 0) + 1,
    '[{"type":"runtime.migration/v1","id":"legacy-prisma"}]',
    '[]'
  FROM "storage_commit";

  DELETE FROM "thread_event";
  DELETE FROM "thread";
  DELETE FROM "project";
END $$;

COMMIT;
