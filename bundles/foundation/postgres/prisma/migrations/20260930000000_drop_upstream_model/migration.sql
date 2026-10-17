-- The unified kind stops guessing what a proxy alias can do: it reads the
-- capabilities from the model catalog the endpoint serves, so the field that
-- named the original model behind an alias goes. A row read back no longer
-- declares a value its kind has stopped asking for.
BEGIN;

UPDATE "provider_configuration"
  SET "field_values" = "field_values" - 'upstreamModel';

COMMIT;
