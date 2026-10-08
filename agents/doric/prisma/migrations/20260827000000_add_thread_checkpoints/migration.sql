-- Per-turn provider-history checkpoints used by Thread history rewind.
BEGIN;

ALTER TABLE "thread" ADD COLUMN "checkpoints" JSONB NOT NULL DEFAULT '{}';

COMMIT;
