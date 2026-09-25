CREATE TYPE "app"."project_member_role" AS ENUM ('EDITOR', 'REVIEWER', 'VIEWER');

ALTER TABLE "app"."project" ADD COLUMN "membership_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "app"."project" ADD CONSTRAINT "project_membership_version_positive" CHECK ("membership_version" >= 1);

CREATE TABLE "app"."project_membership" (
    "project_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "role" "app"."project_member_role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_membership_pkey" PRIMARY KEY ("project_id", "profile_id"),
    CONSTRAINT "project_membership_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "project_membership_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE,
    CONSTRAINT "project_membership_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE TABLE "app"."invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "verified_email" TEXT NOT NULL,
    "role" "app"."project_member_role" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
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
    CONSTRAINT "invitation_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "app"."project"("workspace_id", "id") ON DELETE CASCADE,
    CONSTRAINT "invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT,
    CONSTRAINT "invitation_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT
);

CREATE INDEX "project_membership_profile_id_active_project_id_idx" ON "app"."project_membership"("profile_id", "active", "project_id");
CREATE INDEX "invitation_project_id_created_at_id_idx" ON "app"."invitation"("project_id", "created_at", "id");
CREATE INDEX "invitation_expires_at_idx" ON "app"."invitation"("expires_at");

ALTER TABLE "app"."project_membership" OWNER TO app_migrator;
ALTER TABLE "app"."invitation" OWNER TO app_migrator;

REVOKE ALL ON "app"."project_membership", "app"."invitation" FROM PUBLIC;
REVOKE ALL ON TYPE "app"."project_member_role" FROM PUBLIC;

GRANT USAGE ON TYPE "app"."project_member_role" TO app_web, app_worker;
GRANT SELECT, INSERT ON "app"."project_membership" TO app_web;
GRANT UPDATE ("active", "version", "updated_at") ON "app"."project_membership" TO app_web;
GRANT UPDATE ("active", "version", "updated_at") ON "app"."workspace_membership" TO app_web;
GRANT SELECT, INSERT ON "app"."invitation" TO app_web;
GRANT UPDATE ("accepted_by", "accepted_at", "revoked_at", "version") ON "app"."invitation" TO app_web;
GRANT SELECT ON "app"."project_membership", "app"."invitation" TO app_worker;
GRANT UPDATE ("current_draft_id", "updated_at", "membership_version", "event_sequence", "realtime_epoch") ON "app"."project" TO app_web;
