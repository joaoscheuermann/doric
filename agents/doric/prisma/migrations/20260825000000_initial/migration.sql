-- CreateSchema
-- Clean Project/Thread baseline generated with Prisma migrate diff --from-empty.
-- Transaction, singleton constraint, bootstrap config and tree trigger are owned additions.
BEGIN;

CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ModelRole" AS ENUM ('EXECUTION');

-- CreateEnum
CREATE TYPE "ProjectState" AS ENUM ('QUEUED', 'READY', 'CANCELLING', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ThreadState" AS ENUM ('QUEUED', 'READY', 'RUNNING', 'CANCELLING', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "doric_configuration" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" UUID NOT NULL,
    "max_turns" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doric_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_configuration" (
    "configuration_id" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_env" TEXT NOT NULL,

    CONSTRAINT "provider_configuration_pkey" PRIMARY KEY ("configuration_id","id")
);

-- CreateTable
CREATE TABLE "model_configuration" (
    "configuration_id" INTEGER NOT NULL,
    "role" "ModelRole" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT NOT NULL,

    CONSTRAINT "model_configuration_pkey" PRIMARY KEY ("configuration_id","role")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "state" "ProjectState" NOT NULL DEFAULT 'QUEUED',
    "config_revision" INTEGER NOT NULL,
    "config_snapshot" JSONB NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_thread_id" UUID,
    "state" "ThreadState" NOT NULL DEFAULT 'QUEUED',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "active_prompt_id" UUID,
    "error_code" TEXT,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_event" (
    "project_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "prompt_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_event_pkey" PRIMARY KEY ("thread_id","sequence")
);

-- CreateIndex
CREATE INDEX "project_created_at_id_idx" ON "project"("created_at", "id");

-- CreateIndex
CREATE INDEX "thread_project_id_created_at_id_idx" ON "thread"("project_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "thread_project_id_parent_thread_id_created_at_id_idx" ON "thread"("project_id", "parent_thread_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "thread_project_id_id_key" ON "thread"("project_id", "id");

-- AddForeignKey
ALTER TABLE "provider_configuration" ADD CONSTRAINT "provider_configuration_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "doric_configuration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "doric_configuration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_configuration_id_provider_id_fkey" FOREIGN KEY ("configuration_id", "provider_id") REFERENCES "provider_configuration"("configuration_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_project_id_parent_thread_id_fkey" FOREIGN KEY ("project_id", "parent_thread_id") REFERENCES "thread"("project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_event" ADD CONSTRAINT "thread_event_project_id_thread_id_fkey" FOREIGN KEY ("project_id", "thread_id") REFERENCES "thread"("project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bootstrap the credential-free configuration consumed by the host on startup.
ALTER TABLE "doric_configuration"
  ADD CONSTRAINT "doric_configuration_singleton" CHECK ("id" = 1);

INSERT INTO "doric_configuration" (
  "id", "revision", "generation", "max_turns", "updated_at"
) VALUES (
  1, 1, '00000000-0000-4000-8000-000000000001', 32, CURRENT_TIMESTAMP
);

INSERT INTO "provider_configuration" (
  "configuration_id", "id", "base_url", "api_key_env"
) VALUES (
  1, 'openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'
);

INSERT INTO "model_configuration" (
  "configuration_id", "role", "provider_id", "model", "effort"
) VALUES (
  1, 'EXECUTION', 'openrouter', 'deepseek/deepseek-v4-flash-0731', 'low'
);

-- Parent links never change. Check multi-row inserts and self-parenting too.
CREATE FUNCTION "guard_thread_tree"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."parent_thread_id" IS DISTINCT FROM OLD."parent_thread_id" THEN
      RAISE EXCEPTION 'thread identity and parent are immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT NEW."parent_thread_id" AS id
      UNION
      SELECT t."parent_thread_id" FROM "thread" t JOIN ancestors a ON t."id" = a.id
      WHERE t."parent_thread_id" IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id = NEW."id"
  ) THEN
    RAISE EXCEPTION 'thread parent cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "thread_tree_guard"
  AFTER INSERT OR UPDATE ON "thread"
  FOR EACH ROW EXECUTE FUNCTION "guard_thread_tree"();

COMMIT;
