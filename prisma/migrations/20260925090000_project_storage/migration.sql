CREATE TYPE "app"."project_status" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETING');
CREATE TYPE "app"."scope_draft_status" AS ENUM ('EDITABLE', 'ARCHIVED');

CREATE TABLE "app"."project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "app"."project_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "current_draft_id" UUID,
    "realtime_epoch" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
    CONSTRAINT "project_id_current_draft_id_key" UNIQUE ("id", "current_draft_id"),
    CONSTRAINT "project_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "project_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "project_event_sequence_safe_integer" CHECK ("event_sequence" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "project_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspace"("id") ON DELETE CASCADE
);

CREATE TABLE "app"."scope_draft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "document_revision" INTEGER NOT NULL DEFAULT 1,
    "layout_revision" INTEGER NOT NULL DEFAULT 1,
    "schema_version" INTEGER NOT NULL DEFAULT 3,
    "document_json" JSONB NOT NULL,
    "layout_json" JSONB NOT NULL,
    "status" "app"."scope_draft_status" NOT NULL DEFAULT 'EDITABLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scope_draft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scope_draft_project_id_id_key" UNIQUE ("project_id", "id"),
    CONSTRAINT "scope_draft_document_revision_positive" CHECK ("document_revision" >= 1),
    CONSTRAINT "scope_draft_layout_revision_positive" CHECK ("layout_revision" >= 1),
    CONSTRAINT "scope_draft_schema_version_positive" CHECK ("schema_version" >= 1),
    CONSTRAINT "scope_draft_document_size" CHECK (octet_length("document_json"::text) <= 2097152),
    CONSTRAINT "scope_draft_layout_size" CHECK (octet_length("layout_json"::text) <= 262144),
    CONSTRAINT "scope_draft_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE,
    CONSTRAINT "scope_draft_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

ALTER TABLE "app"."project"
  ADD CONSTRAINT "project_current_draft_fkey"
  FOREIGN KEY ("id", "current_draft_id") REFERENCES "app"."scope_draft"("project_id", "id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "app"."audit_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "actor_id" UUID,
    "service_action" TEXT,
    "action" TEXT NOT NULL,
    "entity_refs" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_event_project_id_sequence_key" UNIQUE ("project_id", "sequence"),
    CONSTRAINT "audit_event_actor_or_service" CHECK (("actor_id" IS NULL) <> ("service_action" IS NULL)),
    CONSTRAINT "audit_event_sequence_positive" CHECK ("sequence" BETWEEN 1 AND 9007199254740991),
    CONSTRAINT "audit_event_action_length" CHECK (char_length("action") BETWEEN 1 AND 120),
    CONSTRAINT "audit_event_service_action_length" CHECK ("service_action" IS NULL OR char_length("service_action") BETWEEN 1 AND 120),
    CONSTRAINT "audit_event_payload_size" CHECK (octet_length("entity_refs"::text) + octet_length("metadata"::text) <= 16384),
    CONSTRAINT "audit_event_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "app"."project"("workspace_id", "id") ON DELETE CASCADE,
    CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "scope_draft_one_editable_per_project" ON "app"."scope_draft"("project_id") WHERE "status" = 'EDITABLE';
CREATE INDEX "project_workspace_id_status_created_at_id_idx" ON "app"."project"("workspace_id", "status", "created_at", "id");
CREATE INDEX "audit_event_project_id_created_at_id_idx" ON "app"."audit_event"("project_id", "created_at", "id");

CREATE FUNCTION "app"."enforce_project_current_draft"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  affected_project_id uuid;
  affected_row jsonb;
BEGIN
  affected_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  affected_project_id := CASE
    WHEN TG_TABLE_NAME = 'project' THEN (affected_row ->> 'id')::uuid
    ELSE (affected_row ->> 'project_id')::uuid
  END;
  IF EXISTS (
    SELECT 1
    FROM app.project AS project
    WHERE project.id = affected_project_id
      AND project.status IN ('ACTIVE', 'ARCHIVED')
      AND (
        project.current_draft_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM app.scope_draft AS draft
          WHERE draft.project_id = project.id
            AND draft.id = project.current_draft_id
            AND draft.status = 'EDITABLE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'active and archived projects require their editable current draft' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "app"."lock_workspace_for_project_creation"(target_workspace_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM app.workspace WHERE id = target_workspace_id FOR UPDATE;
END;
$$;

CREATE CONSTRAINT TRIGGER "project_current_draft_from_project"
AFTER INSERT OR UPDATE OF "status", "current_draft_id" ON "app"."project"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_project_current_draft"();
CREATE CONSTRAINT TRIGGER "project_current_draft_from_scope_draft"
AFTER INSERT OR UPDATE OR DELETE ON "app"."scope_draft"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_project_current_draft"();

ALTER TABLE "app"."project" OWNER TO app_migrator;
ALTER TABLE "app"."scope_draft" OWNER TO app_migrator;
ALTER TABLE "app"."audit_event" OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_project_current_draft"() OWNER TO app_migrator;
ALTER FUNCTION "app"."lock_workspace_for_project_creation"(uuid) OWNER TO app_migrator;

REVOKE ALL ON "app"."project", "app"."scope_draft", "app"."audit_event" FROM PUBLIC;
REVOKE ALL ON TYPE "app"."project_status", "app"."scope_draft_status" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."enforce_project_current_draft"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."lock_workspace_for_project_creation"(uuid) FROM PUBLIC;

GRANT USAGE ON TYPE "app"."project_status", "app"."scope_draft_status" TO app_web, app_worker;
GRANT SELECT, INSERT ON "app"."project", "app"."scope_draft", "app"."audit_event" TO app_web;
GRANT UPDATE ("current_draft_id", "updated_at") ON "app"."project" TO app_web;
GRANT SELECT ON "app"."project", "app"."scope_draft", "app"."audit_event" TO app_worker;
GRANT EXECUTE ON FUNCTION "app"."enforce_project_current_draft"() TO app_web;
GRANT EXECUTE ON FUNCTION "app"."lock_workspace_for_project_creation"(uuid) TO app_web;