-- Drops the legacy `project`, `thread` and `thread_event` tables, with the
-- `guard_thread_tree()` trigger function and the `ProjectState` and
-- `ThreadState` enums that only they use.
--
-- The tables are empty since stage 7 (`20261010000000_runtime_documents`):
-- that migration moved their rows into the `runtime` bundle's storage
-- documents and streams and deleted them, and nothing has written them since.
--
-- The three tables are locked, then counted. A row in any of them raises, and
-- the transaction aborts with nothing dropped. Tables that are already absent
-- are skipped, so applied again, it does nothing.
--
-- This migration cannot be reversed. Back up the database before
-- `prisma migrate deploy`, and apply it with the host stopped and the desktop
-- closed. See the host README, "Legacy rows at the drop migration".
BEGIN;

DO $$
DECLARE
  legacy text;
  held bigint;
BEGIN
  -- Lock before counting. A writer that already holds a table makes this
  -- wait; one that comes later waits for the commit and finds no table.
  FOREACH legacy IN ARRAY ARRAY['thread_event', 'thread', 'project'] LOOP
    IF to_regclass(legacy) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', legacy);
    END IF;
  END LOOP;

  FOREACH legacy IN ARRAY ARRAY['thread_event', 'thread', 'project'] LOOP
    IF to_regclass(legacy) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I', legacy) INTO held;
      IF held > 0 THEN
        RAISE EXCEPTION 'Legacy table "%" holds % rows; they were written after the stage-7 migration. See the host README, "Legacy rows at the drop migration".', legacy, held;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS "thread_event";
DROP TABLE IF EXISTS "thread";
DROP TABLE IF EXISTS "project";

DROP FUNCTION IF EXISTS "guard_thread_tree"();

DROP TYPE IF EXISTS "ThreadState";
DROP TYPE IF EXISTS "ProjectState";

COMMIT;
