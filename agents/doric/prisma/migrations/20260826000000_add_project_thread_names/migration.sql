BEGIN;

ALTER TABLE "project" ADD COLUMN "name" TEXT;
ALTER TABLE "thread" ADD COLUMN "name" TEXT;

UPDATE "project" SET "name" = 'Project ' || "id"::text;
UPDATE "thread" SET "name" = 'Thread ' || "id"::text;

ALTER TABLE "project" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "thread" ALTER COLUMN "name" SET NOT NULL;

COMMIT;
