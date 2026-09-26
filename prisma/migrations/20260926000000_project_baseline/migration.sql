-- ScopeRoom project-only baseline (Stage 02R.1, spec v1.6). Replaces the six Stage 01-02 migrations;
-- every environment that applied them is reset or retired with its own approval.
CREATE TYPE "app"."mutation_scope_kind" AS ENUM ('USER', 'PROJECT');
CREATE TYPE "app"."project_status" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETING');
CREATE TYPE "app"."scope_draft_status" AS ENUM ('EDITABLE', 'ARCHIVED');
CREATE TYPE "app"."project_member_role" AS ENUM ('EDITOR', 'REVIEWER', 'VIEWER');

CREATE TABLE "app"."environment_identity" (
    "id" INTEGER NOT NULL,
    "environment_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "environment_identity_singleton" CHECK ("id" = 1)
);

CREATE TABLE "app"."transaction_fixture" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "namespace" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    CONSTRAINT "transaction_fixture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transaction_fixture_namespace_code_key" UNIQUE ("namespace", "code")
);

CREATE TABLE "app"."user_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_user_id" UUID,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_profile_auth_user_id_key" UNIQUE ("auth_user_id"),
    CONSTRAINT "user_profile_display_name_length" CHECK (char_length("display_name") BETWEEN 1 AND 120),
    CONSTRAINT "user_profile_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL
);

CREATE TABLE "app"."pilot_entitlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "max_owned_projects" INTEGER NOT NULL DEFAULT 10,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "granted_by_operator" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "pilot_entitlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pilot_entitlement_profile_id_key" UNIQUE ("profile_id"),
    CONSTRAINT "pilot_entitlement_max_owned_projects_nonnegative" CHECK ("max_owned_projects" >= 0),
    CONSTRAINT "pilot_entitlement_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."mutation_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "scope_kind" "app"."mutation_scope_kind" NOT NULL,
    "scope_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "mutation_receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mutation_receipt_scope_key" UNIQUE ("actor_id", "scope_kind", "scope_id", "key"),
    CONSTRAINT "mutation_receipt_key_length" CHECK (char_length("key") BETWEEN 16 AND 128),
    CONSTRAINT "mutation_receipt_result_size" CHECK (octet_length("result"::text) <= 65536),
    CONSTRAINT "mutation_receipt_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "app"."project_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "settings_version" INTEGER NOT NULL DEFAULT 1,
    "approval_policy_version" INTEGER NOT NULL DEFAULT 1,
    "membership_version" INTEGER NOT NULL DEFAULT 1,
    "designated_approver_id" UUID,
    "current_draft_id" UUID,
    "realtime_epoch" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_id_current_draft_id_key" UNIQUE ("id", "current_draft_id"),
    CONSTRAINT "project_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "project_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "project_settings_version_positive" CHECK ("settings_version" >= 1),
    CONSTRAINT "project_approval_policy_version_positive" CHECK ("approval_policy_version" >= 1),
    CONSTRAINT "project_membership_version_positive" CHECK ("membership_version" >= 1),
    CONSTRAINT "project_event_sequence_safe_integer" CHECK ("event_sequence" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "project_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT,
    CONSTRAINT "project_designated_approver_id_fkey" FOREIGN KEY ("designated_approver_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
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

CREATE TABLE "app"."project_membership" (
    "project_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "role" "app"."project_member_role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deactivated_sequence" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_membership_pkey" PRIMARY KEY ("project_id", "profile_id"),
    CONSTRAINT "project_membership_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "project_membership_deactivation" CHECK (("active" AND "deactivated_sequence" IS NULL) OR (NOT "active" AND "deactivated_sequence" IS NOT NULL AND "deactivated_sequence" BETWEEN 1 AND 9007199254740991)),
    CONSTRAINT "project_membership_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE,
    CONSTRAINT "project_membership_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "verified_email" TEXT NOT NULL,
    "role" "app"."project_member_role" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "issued_sequence" BIGINT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_by" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitation_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "invitation_accepted_pair" CHECK (("accepted_by" IS NULL) = ("accepted_at" IS NULL)),
    CONSTRAINT "invitation_token_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "invitation_verified_email_length" CHECK (char_length("verified_email") BETWEEN 3 AND 254),
    CONSTRAINT "invitation_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "invitation_issued_sequence_safe_integer" CHECK ("issued_sequence" BETWEEN 1 AND 9007199254740991),
    CONSTRAINT "invitation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE,
    CONSTRAINT "invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT,
    CONSTRAINT "invitation_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."audit_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
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
    CONSTRAINT "audit_event_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE,
    CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "scope_draft_one_editable_per_project" ON "app"."scope_draft"("project_id") WHERE "status" = 'EDITABLE';
CREATE INDEX "project_owner_id_status_updated_at_id_idx" ON "app"."project"("owner_id", "status", "updated_at", "id");
CREATE INDEX "project_membership_profile_id_active_project_id_idx" ON "app"."project_membership"("profile_id", "active", "project_id");
CREATE INDEX "invitation_project_id_created_at_id_idx" ON "app"."invitation"("project_id", "created_at", "id");
CREATE INDEX "invitation_verified_email_idx" ON "app"."invitation"("verified_email");
CREATE INDEX "invitation_expires_at_idx" ON "app"."invitation"("expires_at");
CREATE INDEX "audit_event_project_id_created_at_id_idx" ON "app"."audit_event"("project_id", "created_at", "id");
CREATE INDEX "mutation_receipt_expires_at_idx" ON "app"."mutation_receipt"("expires_at");

CREATE FUNCTION "app"."lock_pilot_entitlement"(profile_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM app.pilot_entitlement WHERE pilot_entitlement.profile_id = lock_pilot_entitlement.profile_id FOR UPDATE;
END;
$$;

CREATE FUNCTION "app"."expire_matching_mutation_receipt"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.mutation_receipt
  WHERE actor_id = NEW.actor_id AND scope_kind = NEW.scope_kind AND scope_id = NEW.scope_id AND key = NEW.key AND expires_at <= CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app"."enforce_project_current_draft"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  affected_project_id uuid;
  affected_row jsonb;
BEGIN
  affected_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  affected_project_id := CASE WHEN TG_TABLE_NAME = 'project' THEN (affected_row ->> 'id')::uuid ELSE (affected_row ->> 'project_id')::uuid END;
  IF EXISTS (
    SELECT 1 FROM app.project AS project
    WHERE project.id = affected_project_id AND project.status IN ('ACTIVE', 'ARCHIVED')
      AND (project.current_draft_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM app.scope_draft AS draft
        WHERE draft.project_id = project.id AND draft.id = project.current_draft_id AND draft.status = 'EDITABLE'))
  ) THEN
    RAISE EXCEPTION 'active and archived projects require their editable current draft' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "app"."reject_owner_membership"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.project WHERE id = NEW.project_id AND owner_id = NEW.profile_id) THEN
    RAISE EXCEPTION 'the project owner cannot hold a project membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expire_matching_mutation_receipt" BEFORE INSERT ON "app"."mutation_receipt"
FOR EACH ROW EXECUTE FUNCTION "app"."expire_matching_mutation_receipt"();
CREATE CONSTRAINT TRIGGER "project_current_draft_from_project" AFTER INSERT OR UPDATE OF "status", "current_draft_id" ON "app"."project"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_project_current_draft"();
CREATE CONSTRAINT TRIGGER "project_current_draft_from_scope_draft" AFTER INSERT OR UPDATE OR DELETE ON "app"."scope_draft"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_project_current_draft"();
-- owner_id is immutable and membership keys are not updatable by runtime roles, so checking inserts suffices.
CREATE TRIGGER "project_membership_not_owner" BEFORE INSERT ON "app"."project_membership"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_owner_membership"();

ALTER TABLE "app"."environment_identity" OWNER TO app_migrator;
ALTER TABLE "app"."transaction_fixture" OWNER TO app_migrator;
ALTER TABLE "app"."user_profile" OWNER TO app_migrator;
ALTER TABLE "app"."pilot_entitlement" OWNER TO app_migrator;
ALTER TABLE "app"."mutation_receipt" OWNER TO app_migrator;
ALTER TABLE "app"."project" OWNER TO app_migrator;
ALTER TABLE "app"."scope_draft" OWNER TO app_migrator;
ALTER TABLE "app"."project_membership" OWNER TO app_migrator;
ALTER TABLE "app"."invitation" OWNER TO app_migrator;
ALTER TABLE "app"."audit_event" OWNER TO app_migrator;
ALTER FUNCTION "app"."lock_pilot_entitlement"(uuid) OWNER TO app_migrator;
ALTER FUNCTION "app"."expire_matching_mutation_receipt"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_project_current_draft"() OWNER TO app_migrator;
ALTER FUNCTION "app"."reject_owner_membership"() OWNER TO app_migrator;

REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON TYPE "app"."mutation_scope_kind", "app"."project_status", "app"."scope_draft_status", "app"."project_member_role" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."lock_pilot_entitlement"(uuid), "app"."expire_matching_mutation_receipt"(), "app"."enforce_project_current_draft"(), "app"."reject_owner_membership"() FROM PUBLIC;

GRANT USAGE ON SCHEMA "app" TO app_web, app_worker;
GRANT USAGE ON TYPE "app"."mutation_scope_kind", "app"."project_status", "app"."scope_draft_status", "app"."project_member_role" TO app_web, app_worker;
GRANT SELECT ON "app"."environment_identity" TO app_web, app_worker;
GRANT SELECT, INSERT, UPDATE ON "app"."transaction_fixture" TO app_web;
GRANT SELECT, INSERT ON "app"."user_profile" TO app_web;
GRANT UPDATE ("display_name", "updated_at") ON "app"."user_profile" TO app_web;
GRANT SELECT ON "app"."pilot_entitlement" TO app_web;
GRANT SELECT, INSERT ON "app"."mutation_receipt" TO app_web;
GRANT SELECT, INSERT ON "app"."project" TO app_web;
GRANT UPDATE ("name", "status", "version", "settings_version", "approval_policy_version", "designated_approver_id", "membership_version", "realtime_epoch", "event_sequence", "current_draft_id", "updated_at") ON "app"."project" TO app_web;
GRANT SELECT, INSERT ON "app"."scope_draft", "app"."audit_event" TO app_web;
GRANT SELECT, INSERT ON "app"."project_membership" TO app_web;
GRANT UPDATE ("active", "role", "version", "deactivated_sequence", "updated_at") ON "app"."project_membership" TO app_web;
GRANT SELECT, INSERT ON "app"."invitation" TO app_web;
GRANT UPDATE ("accepted_by", "accepted_at", "revoked_at", "version") ON "app"."invitation" TO app_web;
GRANT SELECT ON "app"."transaction_fixture", "app"."user_profile", "app"."pilot_entitlement", "app"."mutation_receipt", "app"."project", "app"."scope_draft", "app"."project_membership", "app"."invitation", "app"."audit_event" TO app_worker;
GRANT EXECUTE ON FUNCTION "app"."lock_pilot_entitlement"(uuid), "app"."expire_matching_mutation_receipt"(), "app"."enforce_project_current_draft"(), "app"."reject_owner_membership"() TO app_web;
