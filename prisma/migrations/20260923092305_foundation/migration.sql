-- Foundation identity and the smallest durable table needed to prove restricted transactions.
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

ALTER TABLE "app"."environment_identity" OWNER TO app_migrator;
ALTER TABLE "app"."transaction_fixture" OWNER TO app_migrator;
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
GRANT USAGE ON SCHEMA "app" TO app_web, app_worker;
GRANT SELECT ON "app"."environment_identity" TO app_web, app_worker;
GRANT SELECT, INSERT, UPDATE ON "app"."transaction_fixture" TO app_web;
GRANT SELECT ON "app"."transaction_fixture" TO app_worker;
