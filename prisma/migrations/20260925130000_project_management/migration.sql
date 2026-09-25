ALTER TYPE "app"."workspace_status" ADD VALUE 'ARCHIVED';

ALTER TABLE "app"."project"
  ADD COLUMN "settings_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "approval_policy_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "designated_approver_id" UUID,
  ADD CONSTRAINT "project_settings_version_positive" CHECK ("settings_version" >= 1),
  ADD CONSTRAINT "project_approval_policy_version_positive" CHECK ("approval_policy_version" >= 1),
  ADD CONSTRAINT "project_designated_approver_id_fkey"
    FOREIGN KEY ("designated_approver_id") REFERENCES "app"."user_profile"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

GRANT UPDATE ("status", "version", "updated_at") ON "app"."workspace" TO app_web;
GRANT UPDATE ("name", "status", "version", "settings_version", "approval_policy_version", "designated_approver_id", "membership_version", "realtime_epoch", "event_sequence", "updated_at") ON "app"."project" TO app_web;
GRANT UPDATE ("active", "role", "version", "updated_at") ON "app"."project_membership" TO app_web;
GRANT UPDATE ("revoked_at", "version") ON "app"."invitation" TO app_web;