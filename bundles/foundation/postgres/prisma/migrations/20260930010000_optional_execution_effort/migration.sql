-- The execution effort is absent when the model lists none, so the column is
-- nullable: a model whose catalog names no efforts cannot be told one.
BEGIN;

ALTER TABLE "model_configuration"
  ALTER COLUMN "effort" DROP NOT NULL;

COMMIT;
