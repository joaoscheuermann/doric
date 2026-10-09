-- Reasoning efforts become per model, and the OpenAI-compatible kind stops
-- asking the operator for an identity: the provider's own id and name are that
-- identity, so the two fields that carried it go.
--
-- Order matters. The new `models` column is added and back-filled before the two
-- array columns are dropped, so no configured provider loses the models it
-- named. Each old model id becomes one object whose `reasonings` is the old
-- provider-level effort list, which is exactly the menu every model shared. Then
-- the identity keys leave `field_values`, so a row read back no longer declares a
-- value its kind has stopped asking for.
BEGIN;

ALTER TABLE "provider_configuration"
  ADD COLUMN "models" JSONB NOT NULL DEFAULT '[]';

UPDATE "provider_configuration" SET "models" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'name', "model",
        'reasonings', to_jsonb("reasoning_efforts")
      )
    )
    FROM unnest("model_ids") AS "model"
  ),
  '[]'::jsonb
);

UPDATE "provider_configuration"
  SET "field_values" = "field_values" - 'identityId' - 'identityName';

ALTER TABLE "provider_configuration"
  DROP COLUMN "model_ids",
  DROP COLUMN "reasoning_efforts";

COMMIT;
