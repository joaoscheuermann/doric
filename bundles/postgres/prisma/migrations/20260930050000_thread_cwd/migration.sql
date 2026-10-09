-- Every Thread owns a working directory inside its Project's shared sandbox,
-- and a cheap hint of whether that directory's root holds a Git repository. A
-- Thread that predates the column keeps the workspace root it ran in.
BEGIN;

ALTER TABLE "thread"
  ADD COLUMN "cwd" TEXT NOT NULL DEFAULT '/workspace',
  ADD COLUMN "cwd_repo" TEXT;

COMMIT;
