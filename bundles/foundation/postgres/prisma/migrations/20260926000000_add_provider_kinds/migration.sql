-- A configured provider names a kind and that kind's own values, and keeps the
-- lists its kind declares. The credential stays a real column: a provider's
-- token is a reference to the credential store, and PostgreSQL can keep that
-- reference while JSONB cannot.
--
-- Order matters. The new columns are added and back-filled before `base_url` is
-- dropped, so no configured provider is lost and no credential reference moves:
-- `credential_id` keeps its value and only becomes nullable, because a kind whose
-- token is optional names no credential when an operator sets none.
--
-- Every existing row was built by the host as an OpenAI-compatible provider under
-- its own id, so that is the kind it is carried over as, with the base URL it
-- used as its endpoint override. Its model and reasoning lists start empty rather
-- than being guessed from the execution model: the row is the operator's, and an
-- empty list is a state the execution section renders as a free-text choice.
BEGIN;

ALTER TABLE "provider_configuration"
  ADD COLUMN "kind" TEXT,
  ADD COLUMN "field_values" JSONB,
  ADD COLUMN "model_ids" TEXT[],
  ADD COLUMN "reasoning_efforts" TEXT[];

UPDATE "provider_configuration" SET
  "kind" = 'openai-compatible',
  "field_values" = jsonb_build_object(
    'identityId', "id",
    'identityName', "id",
    'endpoint', "base_url"
  ),
  "model_ids" = '{}',
  "reasoning_efforts" = '{}';

ALTER TABLE "provider_configuration"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "field_values" SET NOT NULL,
  ALTER COLUMN "model_ids" SET NOT NULL,
  ALTER COLUMN "reasoning_efforts" SET NOT NULL,
  ALTER COLUMN "credential_id" DROP NOT NULL,
  DROP COLUMN "base_url";

COMMIT;