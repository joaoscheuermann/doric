-- Preserve provider ids, credentials, model choices and historical snapshots.
-- LM Studio's removed protocols cannot be mapped safely to Responses.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "provider_configuration"
    WHERE "kind" IN ('lmstudio', 'lmstudio-openai')
  ) THEN
    RAISE EXCEPTION 'Replace LM Studio providers with OpenAI Responses or OpenRouter in the previous Doric version before applying this migration.';
  END IF;
END $$;

UPDATE "provider_configuration"
SET "kind" = CASE
  WHEN "kind" = 'unified' THEN 'openrouter'
  -- The original bootstrap used the compatible kind for the OpenRouter URL.
  WHEN "kind" = 'openai-compatible'
    AND rtrim("field_values"->>'endpoint', '/') = 'https://openrouter.ai/api/v1'
    THEN 'openrouter'
  ELSE 'openai'
END
WHERE "kind" IN ('unified', 'openai-compatible');

UPDATE "doric_configuration"
SET "revision" = "revision" + 1,
    "generation" = gen_random_uuid(),
    "updated_at" = CURRENT_TIMESTAMP;

COMMIT;
