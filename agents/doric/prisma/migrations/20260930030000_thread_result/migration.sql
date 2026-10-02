-- The materialized result of a thread's most recent finished prompt. It is
-- stored on the thread rather than reconstructed from its event log, so reading
-- a child's state never carries the whole transcript. Absent until a prompt
-- finishes.
BEGIN;

ALTER TABLE "thread"
  ADD COLUMN "result_text" TEXT,
  ADD COLUMN "result_status" TEXT,
  ADD COLUMN "result_prompt_id" UUID,
  ADD COLUMN "result_at" TIMESTAMPTZ(3);

COMMIT;
