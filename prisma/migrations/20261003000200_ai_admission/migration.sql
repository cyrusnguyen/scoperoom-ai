-- Stage 06.1 admission: the keyed abuse-limit bucket introduced with its first consumer (AI_ADMISSION). Not a provider quota or a run ledger.
CREATE TABLE "app"."rate_limit_bucket" (
  "subject_hash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "count" INTEGER NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("subject_hash", "action", "window_start"),
  CONSTRAINT "rate_limit_bucket_subject" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "rate_limit_bucket_action" CHECK ("action" IN ('AI_ADMISSION')),
  CONSTRAINT "rate_limit_bucket_count" CHECK ("count" BETWEEN 0 AND 1000),
  CONSTRAINT "rate_limit_bucket_expiry" CHECK ("expires_at" > "window_start" AND "expires_at" <= "window_start" + INTERVAL '1 day')
);
CREATE INDEX "rate_limit_bucket_expires_at_idx" ON "app"."rate_limit_bucket"("expires_at");

ALTER TABLE "app"."rate_limit_bucket" OWNER TO app_migrator;
REVOKE ALL ON TABLE "app"."rate_limit_bucket" FROM PUBLIC;
-- Web counts attempts and prunes expired rows; the worker never touches it.
GRANT SELECT, INSERT, DELETE ON "app"."rate_limit_bucket" TO app_web;
GRANT UPDATE ("count") ON "app"."rate_limit_bucket" TO app_web;
-- Admission serializes an owner's projects with SELECT ... FOR UPDATE on the allowance row, which PostgreSQL gates on UPDATE of at least one column.
GRANT UPDATE ("created_at") ON "app"."ai_owner_allowance" TO app_web;
