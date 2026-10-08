-- GitHub identity and write-only token for the singleton configuration.
BEGIN;

ALTER TABLE "doric_configuration" ADD COLUMN "github_email" TEXT,
ADD COLUMN "github_token" TEXT,
ADD COLUMN "github_username" TEXT;

COMMIT;
