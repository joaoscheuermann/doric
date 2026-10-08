-- The credential store: named credentials, an encrypted secret column, and the
-- provider/configuration references that replace `api_key_env` and the plaintext
-- GitHub identity columns.
--
-- Order matters. Everything is added and back-filled before a single column is
-- dropped, so no provider and no configured GitHub identity is lost. The one
-- value that cannot be carried over is the legacy plaintext token, because
-- AES-256-GCM only runs in the host process: its row is created with an empty
-- secret and the operator re-enters the token once through the credentials API,
-- which stores it encrypted.
BEGIN;

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('API_TOKEN', 'USERNAME_PASSWORD', 'GIT');

-- CreateTable
CREATE TABLE "credential" (
    "id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "secret" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_kind_name_key" ON "credential"("kind", "name");

-- AddColumn: the two configuration choices stay nullable, and absent means
-- "this host has no Git identity / no GitHub token".
ALTER TABLE "doric_configuration"
  ADD COLUMN "git_credential_id" UUID,
  ADD COLUMN "github_credential_id" UUID;

ALTER TABLE "provider_configuration" ADD COLUMN "credential_id" UUID;

-- Carry the configured GitHub identity into a GIT credential. The ids are fixed
-- so the seeded baseline is reproducible.
INSERT INTO "credential" (
  "id", "kind", "name", "username", "email", "secret", "updated_at"
) SELECT
  '00000000-0000-4000-8000-000000000003', 'GIT', 'github',
  "github_username", "github_email", NULL, CURRENT_TIMESTAMP
FROM "doric_configuration"
WHERE "id" = 1 AND "github_username" IS NOT NULL AND "github_email" IS NOT NULL;

-- Carry the configured GitHub token's row, not its value: an empty secret means
-- "unconfigured", which is the same state the settings surface shows for the
-- provider keys below.
INSERT INTO "credential" (
  "id", "kind", "name", "username", "email", "secret", "updated_at"
) SELECT
  '00000000-0000-4000-8000-000000000004', 'API_TOKEN', 'github',
  NULL, NULL, '', CURRENT_TIMESTAMP
FROM "doric_configuration"
WHERE "id" = 1 AND "github_token" IS NOT NULL;

UPDATE "doric_configuration" SET
  "git_credential_id" = '00000000-0000-4000-8000-000000000003'
WHERE "id" = 1
  AND EXISTS (SELECT 1 FROM "credential" WHERE "id" = '00000000-0000-4000-8000-000000000003');

UPDATE "doric_configuration" SET
  "github_credential_id" = '00000000-0000-4000-8000-000000000004'
WHERE "id" = 1
  AND EXISTS (SELECT 1 FROM "credential" WHERE "id" = '00000000-0000-4000-8000-000000000004');

-- Every provider keeps its row: the old model named an environment variable, so
-- there is no stored value to carry. One API_TOKEN credential per distinct name,
-- with an empty secret the operator fills in, so no provider is silently lost.
-- The baseline's one provider keeps a fixed credential id, because the seeded
-- configuration is expected to equal `defaultConfig`.
INSERT INTO "credential" (
  "id", "kind", "name", "username", "email", "secret", "updated_at"
) SELECT
  '00000000-0000-4000-8000-000000000002', 'API_TOKEN', 'OPENROUTER_API_KEY',
  NULL, NULL, '', CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "provider_configuration" WHERE "api_key_env" = 'OPENROUTER_API_KEY'
)
ON CONFLICT ("kind", "name") DO NOTHING;

INSERT INTO "credential" (
  "id", "kind", "name", "username", "email", "secret", "updated_at"
) SELECT
  gen_random_uuid(), 'API_TOKEN', "api_key_env", NULL, NULL, '',
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "api_key_env" FROM "provider_configuration"
  WHERE "api_key_env" <> 'OPENROUTER_API_KEY'
) AS "providers"
ON CONFLICT ("kind", "name") DO NOTHING;

UPDATE "provider_configuration" AS "provider"
SET "credential_id" = "credential"."id"
FROM "credential"
WHERE "credential"."kind" = 'API_TOKEN'
  AND "credential"."name" = "provider"."api_key_env";

ALTER TABLE "provider_configuration" ALTER COLUMN "credential_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "provider_configuration" ADD CONSTRAINT "provider_configuration_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doric_configuration" ADD CONSTRAINT "doric_configuration_git_credential_id_fkey"
  FOREIGN KEY ("git_credential_id") REFERENCES "credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doric_configuration" ADD CONSTRAINT "doric_configuration_github_credential_id_fkey"
  FOREIGN KEY ("github_credential_id") REFERENCES "credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropColumn
ALTER TABLE "doric_configuration"
  DROP COLUMN "github_username",
  DROP COLUMN "github_email",
  DROP COLUMN "github_token";

ALTER TABLE "provider_configuration" DROP COLUMN "api_key_env";

COMMIT;
