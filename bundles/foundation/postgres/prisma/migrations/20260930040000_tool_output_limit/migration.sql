-- The cap on how many characters of one tool result may reach the model. It is
-- a column so an operator sets it from the settings surface; absent means no
-- cap, which keeps the value that predates the column behaving as before.
BEGIN;

ALTER TABLE "doric_configuration"
  ADD COLUMN "max_tool_result_chars" INTEGER;

COMMIT;
