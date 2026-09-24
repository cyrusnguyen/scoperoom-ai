CREATE TYPE "app"."workspace_status" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "app"."workspace_member_role" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "app"."mutation_scope_kind" AS ENUM ('USER', 'WORKSPACE', 'PROJECT');

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
    "max_workspaces" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "granted_by_operator" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "pilot_entitlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pilot_entitlement_profile_id_key" UNIQUE ("profile_id"),
    CONSTRAINT "pilot_entitlement_max_workspaces_nonnegative" CHECK ("max_workspaces" >= 0),
    CONSTRAINT "pilot_entitlement_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."workspace" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "app"."workspace_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "workspace_version_nonnegative" CHECK ("version" >= 0),
    CONSTRAINT "workspace_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."workspace_membership" (
    "workspace_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "role" "app"."workspace_member_role" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_membership_pkey" PRIMARY KEY ("workspace_id", "profile_id"),
    CONSTRAINT "workspace_membership_version_nonnegative" CHECK ("version" >= 0),
    CONSTRAINT "workspace_membership_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspace"("id") ON DELETE CASCADE,
    CONSTRAINT "workspace_membership_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
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

CREATE INDEX "workspace_owner_id_idx" ON "app"."workspace"("owner_id");
CREATE INDEX "workspace_membership_profile_id_active_idx" ON "app"."workspace_membership"("profile_id", "active");
CREATE INDEX "mutation_receipt_expires_at_idx" ON "app"."mutation_receipt"("expires_at");

CREATE FUNCTION "app"."enforce_workspace_owner_membership"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  affected_workspace_id uuid;
  owner_profile_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'workspace' THEN
    affected_workspace_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    affected_workspace_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  END IF;
  SELECT owner_id INTO owner_profile_id FROM app.workspace WHERE id = affected_workspace_id;
  IF owner_profile_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_membership WHERE workspace_id = affected_workspace_id AND profile_id = owner_profile_id AND role = 'OWNER' AND active) THEN
    RAISE EXCEPTION 'workspace owner requires an active OWNER membership' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_membership WHERE workspace_id = affected_workspace_id AND role = 'OWNER' AND profile_id <> owner_profile_id) THEN
    RAISE EXCEPTION 'only the workspace owner may hold OWNER membership' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "app"."lock_pilot_entitlement"(profile_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM app.pilot_entitlement WHERE pilot_entitlement.profile_id = lock_pilot_entitlement.profile_id FOR UPDATE;
END;
$$;

CREATE FUNCTION "app"."expire_matching_mutation_receipt"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.mutation_receipt
  WHERE actor_id = NEW.actor_id AND scope_kind = NEW.scope_kind AND scope_id = NEW.scope_id AND key = NEW.key AND expires_at <= CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expire_matching_mutation_receipt"
BEFORE INSERT ON "app"."mutation_receipt"
FOR EACH ROW EXECUTE FUNCTION "app"."expire_matching_mutation_receipt"();

CREATE CONSTRAINT TRIGGER "workspace_owner_membership_from_workspace"
AFTER INSERT OR UPDATE OF "owner_id" ON "app"."workspace"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_workspace_owner_membership"();
CREATE CONSTRAINT TRIGGER "workspace_owner_membership_from_membership"
AFTER INSERT OR UPDATE OR DELETE ON "app"."workspace_membership"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_workspace_owner_membership"();

ALTER TABLE "app"."user_profile" OWNER TO app_migrator;
ALTER TABLE "app"."pilot_entitlement" OWNER TO app_migrator;
ALTER TABLE "app"."workspace" OWNER TO app_migrator;
ALTER TABLE "app"."workspace_membership" OWNER TO app_migrator;
ALTER TABLE "app"."mutation_receipt" OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_workspace_owner_membership"() OWNER TO app_migrator;
ALTER FUNCTION "app"."expire_matching_mutation_receipt"() OWNER TO app_migrator;
ALTER FUNCTION "app"."lock_pilot_entitlement"(uuid) OWNER TO app_migrator;

REVOKE ALL ON "app"."user_profile", "app"."pilot_entitlement", "app"."workspace", "app"."workspace_membership", "app"."mutation_receipt" FROM PUBLIC;
REVOKE ALL ON TYPE "app"."workspace_status", "app"."workspace_member_role", "app"."mutation_scope_kind" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."enforce_workspace_owner_membership"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."expire_matching_mutation_receipt"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."lock_pilot_entitlement"(uuid) FROM PUBLIC;

GRANT USAGE ON TYPE "app"."workspace_status", "app"."workspace_member_role", "app"."mutation_scope_kind" TO app_web, app_worker;
GRANT SELECT, INSERT ON "app"."user_profile" TO app_web;
GRANT UPDATE ("display_name", "updated_at") ON "app"."user_profile" TO app_web;
GRANT SELECT ON "app"."pilot_entitlement" TO app_web, app_worker;
GRANT SELECT, INSERT ON "app"."workspace" TO app_web;
GRANT SELECT, INSERT ON "app"."workspace_membership" TO app_web;
GRANT SELECT, INSERT ON "app"."mutation_receipt" TO app_web;
GRANT SELECT ON "app"."user_profile", "app"."workspace", "app"."workspace_membership", "app"."mutation_receipt" TO app_worker;
GRANT EXECUTE ON FUNCTION "app"."enforce_workspace_owner_membership"() TO app_web;
GRANT EXECUTE ON FUNCTION "app"."expire_matching_mutation_receipt"() TO app_web;
GRANT EXECUTE ON FUNCTION "app"."lock_pilot_entitlement"(uuid) TO app_web;
