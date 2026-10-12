-- Generic storage (`storage.backend/v1`) and the Doric configuration as one
-- `settings/v1` space. The configuration rows are converted losslessly into
-- the `host-config.configuration/v1` settings document, the conversion is
-- verified, and only then are the configuration tables dropped.
--
-- The provider-kind facts are embedded as they are on the day this migration
-- is written: every kind's only secret field is `token`, `openai` and
-- `openrouter` keep a model list, and `codex` keeps none. A stored kind
-- outside that set is neither discarded nor converted: the migration stops.
--
-- This migration cannot be reversed. Back up the database before
-- `prisma migrate deploy`.
BEGIN;

CREATE TABLE "storage_meta" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  CONSTRAINT "storage_meta_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "storage_type" (
  "type" TEXT COLLATE "C" NOT NULL,
  "indexes" JSONB NOT NULL,
  "declared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_type_pkey" PRIMARY KEY ("type")
);

CREATE TABLE "storage_document" (
  "type" TEXT COLLATE "C" NOT NULL,
  "id" TEXT COLLATE "C" NOT NULL,
  "revision" INTEGER NOT NULL,
  "value" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_document_pkey" PRIMARY KEY ("type", "id"),
  CONSTRAINT "storage_document_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "storage_index_entry" (
  "type" TEXT COLLATE "C" NOT NULL,
  "index_name" TEXT COLLATE "C" NOT NULL,
  "key" BYTEA NOT NULL,
  "document_id" TEXT COLLATE "C" NOT NULL,
  "unique_key" BOOLEAN NOT NULL,
  CONSTRAINT "storage_index_entry_pkey" PRIMARY KEY ("type", "index_name", "key", "document_id"),
  CONSTRAINT "storage_index_entry_type_document_id_fkey" FOREIGN KEY ("type", "document_id")
    REFERENCES "storage_document" ("type", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Raw-SQL owned: Prisma cannot express a partial unique index.
CREATE UNIQUE INDEX "storage_index_entry_unique_key"
  ON "storage_index_entry" ("type", "index_name", "key") WHERE "unique_key";

CREATE INDEX "storage_index_entry_type_document_id_idx"
  ON "storage_index_entry" ("type", "document_id");

CREATE TABLE "storage_stream" (
  "stream" TEXT COLLATE "C" NOT NULL,
  "last_sequence" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "storage_stream_pkey" PRIMARY KEY ("stream")
);

CREATE TABLE "storage_stream_entry" (
  "stream" TEXT COLLATE "C" NOT NULL,
  "sequence" INTEGER NOT NULL,
  "value" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_stream_entry_pkey" PRIMARY KEY ("stream", "sequence"),
  CONSTRAINT "storage_stream_entry_stream_fkey" FOREIGN KEY ("stream")
    REFERENCES "storage_stream" ("stream") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "storage_commit" (
  "position" BIGINT NOT NULL,
  "documents" JSONB NOT NULL,
  "streams" JSONB NOT NULL,
  "truncated" JSONB NOT NULL DEFAULT '[]',
  "dropped" JSONB NOT NULL DEFAULT '[]',
  "committed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_commit_pkey" PRIMARY KEY ("position")
);

CREATE TABLE "storage_truncation" (
  "stream" TEXT COLLATE "C" NOT NULL,
  "position" BIGINT NOT NULL,
  "after_sequence" INTEGER NOT NULL,
  "at_sequence" INTEGER NOT NULL,
  CONSTRAINT "storage_truncation_pkey" PRIMARY KEY ("stream", "position"),
  CONSTRAINT "storage_truncation_stream_fkey" FOREIGN KEY ("stream")
    REFERENCES "storage_stream" ("stream") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "storage_truncation_position_fkey" FOREIGN KEY ("position")
    REFERENCES "storage_commit" ("position") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "storage_blob" (
  "hash" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  "size" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_blob_pkey" PRIMARY KEY ("hash")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "provider_configuration"
    WHERE "kind" NOT IN ('openai', 'openrouter', 'codex')
  ) THEN
    RAISE EXCEPTION 'A stored provider kind is not supported; replace it in the previous Doric version before applying this migration.';
  END IF;

  IF (SELECT count(*) FROM "doric_configuration") <> 1
    OR NOT EXISTS (
      SELECT 1 FROM "model_configuration"
      WHERE "configuration_id" = 1 AND "role" = 'EXECUTION'
    ) THEN
    RAISE EXCEPTION 'Stored Doric model role is missing: EXECUTION';
  END IF;
END $$;

-- The conversion is one commit of the generic storage, so the feed starts
-- with it.
INSERT INTO "storage_commit" ("position", "documents", "streams")
VALUES (
  1,
  '[{"type":"core.settings/v1","id":"host-config.configuration/v1"},{"type":"core.settings-generation/v1","id":"global"}]',
  '[]'
);

-- The configuration exactly as the previous store read it back before its
-- schema check: each provider's field values with its credential as `token`,
-- its model list when its kind keeps one (or when the row holds models it
-- should not, so the schema still rejects them), the execution model with its
-- effort only when one is set, the turn limit with the tool-result cap only
-- when one is set, the tool configuration, and the Git and GitHub credentials
-- only when they are named. The revision and the update time carry over, so
-- the next replacement answers the next revision.
INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
SELECT
  'core.settings/v1',
  'host-config.configuration/v1',
  c."revision",
  jsonb_build_object(
    'version', '1.0.0',
    'updatedAt', to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'generation', c."revision",
    'value',
      jsonb_build_object(
        'providers', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', p."id",
              'kind', p."kind",
              'configuration', p."field_values"
                || CASE
                     WHEN p."credential_id" IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('token', p."credential_id"::text)
                   END
            )
            || CASE
                 WHEN jsonb_typeof(p."models") = 'array'
                   AND (p."kind" IN ('openai', 'openrouter') OR jsonb_array_length(p."models") > 0)
                   THEN jsonb_build_object('models', p."models")
                 ELSE '{}'::jsonb
               END
            ORDER BY p."id"
          )
          FROM "provider_configuration" p
          WHERE p."configuration_id" = c."id"
        ), '[]'::jsonb),
        'models', jsonb_build_object(
          'execution',
          jsonb_build_object('providerId', m."provider_id", 'model', m."model")
          || CASE
               WHEN m."effort" IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('effort', m."effort")
             END
        ),
        'execution', jsonb_build_object('maxTurns', c."max_turns")
          || CASE
               WHEN c."max_tool_result_chars" IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('maxToolResultChars', c."max_tool_result_chars")
             END,
        'tools', c."tool_config"
      )
      || CASE
           WHEN c."git_credential_id" IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('gitCredentialId', c."git_credential_id"::text)
         END
      || CASE
           WHEN c."github_credential_id" IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('githubCredentialId', c."github_credential_id"::text)
         END
  ),
  c."updated_at"
FROM "doric_configuration" c
JOIN "model_configuration" m
  ON m."configuration_id" = c."id" AND m."role" = 'EXECUTION'
WHERE c."id" = 1;

-- The global settings generation starts equal to the configuration revision,
-- the only space ever written so far.
INSERT INTO "storage_document" ("type", "id", "revision", "value", "updated_at")
SELECT
  'core.settings-generation/v1',
  'global',
  1,
  jsonb_build_object('generation', "revision"),
  "updated_at"
FROM "doric_configuration"
WHERE "id" = 1;

-- Verification read before the switch.
DO $$
DECLARE
  converted jsonb;
BEGIN
  SELECT "value"->'value' INTO converted
  FROM "storage_document"
  WHERE "type" = 'core.settings/v1' AND "id" = 'host-config.configuration/v1';

  IF converted IS NULL
    OR jsonb_array_length(converted->'providers') <> (
      SELECT count(*) FROM "provider_configuration" WHERE "configuration_id" = 1
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements(converted->'providers') e
      WHERE e->'configuration' ? 'token'
    ) <> (
      SELECT count(*) FROM "provider_configuration"
      WHERE "configuration_id" = 1 AND "credential_id" IS NOT NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM "storage_document"
      WHERE "type" = 'core.settings-generation/v1' AND "id" = 'global'
    )
  THEN
    RAISE EXCEPTION 'The Doric configuration conversion could not be verified.';
  END IF;
END $$;

DROP TABLE "model_configuration";
DROP TABLE "provider_configuration";
DROP TABLE "doric_configuration";
DROP TYPE "ModelRole";

COMMIT;
