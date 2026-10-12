-- Per-tool configuration values, keyed by tool name and then by the tool's own
-- field keys. The column is JSON because the fields a tool declares load at
-- runtime with its bundle, so no static schema can name them; the values are
-- validated against each tool's declared fields when the tool is bound to a
-- prompt. An empty object is every tool left at its own defaults.
BEGIN;

ALTER TABLE "doric_configuration"
  ADD COLUMN "tool_config" JSONB NOT NULL DEFAULT '{}';

COMMIT;
