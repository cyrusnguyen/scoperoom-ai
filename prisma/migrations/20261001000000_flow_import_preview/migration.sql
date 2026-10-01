CREATE TYPE "app"."flow_import_state" AS ENUM ('READY', 'DISCARDED', 'EXPIRED', 'APPLIED');

CREATE TABLE "app"."flow_import_preview" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "draft_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "format_version" INTEGER NOT NULL DEFAULT 1,
  "expected_document_revision" INTEGER NOT NULL,
  "state" "app"."flow_import_state" NOT NULL DEFAULT 'READY',
  "payload" JSONB,
  "positions" JSONB,
  "fidelity_report" JSONB,
  "preview_hash" CHAR(64) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "applied_at" TIMESTAMPTZ(6),
  "result_flow_id" UUID,
  "applied_mapping" JSONB,
  "applied_result" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_import_preview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flow_import_preview_project_draft_fkey" FOREIGN KEY ("project_id", "draft_id") REFERENCES "app"."scope_draft"("project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "flow_import_preview_project_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "flow_import_preview_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "flow_import_preview_revision_positive" CHECK ("expected_document_revision" > 0),
  CONSTRAINT "flow_import_preview_format_version" CHECK ("format_version" = 1),
  CONSTRAINT "flow_import_preview_expiry" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "flow_import_preview_hash" CHECK ("preview_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "flow_import_preview_payload_hash" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "flow_import_preview_bodies" CHECK (
    (payload IS NOT NULL AND positions IS NOT NULL AND fidelity_report IS NOT NULL)
    OR (state <> 'READY' AND payload IS NULL AND positions IS NULL AND fidelity_report IS NULL)
  ),
  CONSTRAINT "flow_import_preview_payload_size" CHECK ("payload" IS NULL OR octet_length("payload"::text) <= 1048576),
  CONSTRAINT "flow_import_preview_positions_size" CHECK ("positions" IS NULL OR octet_length("positions"::text) <= 262144),
  CONSTRAINT "flow_import_preview_report_size" CHECK ("fidelity_report" IS NULL OR octet_length("fidelity_report"::text) <= 65536),
  CONSTRAINT "flow_import_preview_mapping_size" CHECK ("applied_mapping" IS NULL OR octet_length("applied_mapping"::text) <= 65536),
  CONSTRAINT "flow_import_preview_result_size" CHECK ("applied_result" IS NULL OR octet_length("applied_result"::text) <= 65536),
  CONSTRAINT "flow_import_preview_result_shape" CHECK (state <> 'APPLIED' OR COALESCE(
    jsonb_typeof(applied_result) = 'object' AND jsonb_typeof(applied_mapping) = 'object'
    AND applied_result - ARRAY['previewId', 'draftId', 'flowId', 'documentRevision', 'layoutRevision', 'eventSequence'] = '{}'::jsonb
    AND applied_result->>'previewId' = id::text AND applied_result->>'draftId' = draft_id::text
    AND applied_result->>'flowId' = result_flow_id::text AND applied_mapping->>'flowId' = result_flow_id::text
    AND jsonb_typeof(applied_mapping->'nodes') = 'object' AND jsonb_typeof(applied_mapping->'edges') = 'object'
    AND jsonb_typeof(applied_result->'documentRevision') = 'number' AND applied_result->>'documentRevision' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(applied_result->'layoutRevision') = 'number' AND applied_result->>'layoutRevision' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(applied_result->'eventSequence') = 'number' AND applied_result->>'eventSequence' ~ '^[1-9][0-9]*$'
    AND applied_result->'documentRevision' <= '9007199254740991'::jsonb AND applied_result->'layoutRevision' <= '9007199254740991'::jsonb
    AND applied_result->'eventSequence' <= '9007199254740991'::jsonb, false)),
  CONSTRAINT "flow_import_preview_applied_result" CHECK (
    ("state" = 'APPLIED' AND "applied_at" IS NOT NULL AND "result_flow_id" IS NOT NULL AND "applied_mapping" IS NOT NULL AND "applied_result" IS NOT NULL)
    OR ("state" <> 'APPLIED' AND "applied_at" IS NULL AND "result_flow_id" IS NULL AND "applied_mapping" IS NULL AND "applied_result" IS NULL)
  )
);

CREATE INDEX "flow_import_preview_expiry_idx" ON "app"."flow_import_preview" ("expires_at", "id");
CREATE INDEX "flow_import_preview_project_actor_idx" ON "app"."flow_import_preview" ("project_id", "actor_id", "id");

CREATE FUNCTION "app"."enforce_flow_import_preview"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.format_version IS DISTINCT FROM OLD.format_version OR NEW.expected_document_revision IS DISTINCT FROM OLD.expected_document_revision
    OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'flow import identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.payload IS NULL AND NEW.payload IS NOT NULL) OR (OLD.payload IS NOT NULL AND NEW.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload)
    OR (OLD.positions IS NULL AND NEW.positions IS NOT NULL) OR (OLD.positions IS NOT NULL AND NEW.positions IS NOT NULL AND NEW.positions IS DISTINCT FROM OLD.positions)
    OR (OLD.fidelity_report IS NULL AND NEW.fidelity_report IS NOT NULL) OR (OLD.fidelity_report IS NOT NULL AND NEW.fidelity_report IS NOT NULL AND NEW.fidelity_report IS DISTINCT FROM OLD.fidelity_report) THEN
    RAISE EXCEPTION 'flow import body is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'READY' THEN
    IF NEW.state NOT IN ('READY', 'DISCARDED', 'EXPIRED', 'APPLIED') THEN RAISE EXCEPTION 'invalid flow import transition' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'APPLIED' AND OLD.expires_at <= CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'flow import expired' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'flow import not expired' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal flow import state is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.payload IS NOT NULL AND NEW.payload IS NULL AND (NEW.state = 'READY' OR (NEW.state = 'APPLIED' AND NEW.applied_at > CURRENT_TIMESTAMP - INTERVAL '7 days')) THEN
    RAISE EXCEPTION 'flow import body retention boundary' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'APPLIED' AND (NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.result_flow_id IS DISTINCT FROM OLD.result_flow_id
    OR NEW.applied_mapping IS DISTINCT FROM OLD.applied_mapping OR NEW.applied_result IS DISTINCT FROM OLD.applied_result) THEN
    RAISE EXCEPTION 'applied flow import result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "enforce_flow_import_preview" BEFORE UPDATE ON "app"."flow_import_preview"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_flow_import_preview"();

CREATE FUNCTION "app"."cleanup_transient"(p_dry_run boolean, p_batch_size integer)
RETURNS TABLE("expiredPreviews" integer, "clearedAppliedBodies" integer, "deletedReceipts" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app
AS $$
DECLARE
  limit_rows integer := LEAST(GREATEST(p_batch_size, 1), 100);
  clock_now timestamptz := CURRENT_TIMESTAMP;
BEGIN
  PERFORM set_config('statement_timeout', '5000', true);
  IF p_dry_run THEN
    SELECT count(*)::integer INTO "expiredPreviews" FROM (SELECT 1 FROM app.flow_import_preview WHERE state IN ('READY', 'EXPIRED') AND payload IS NOT NULL AND expires_at <= clock_now ORDER BY expires_at, id LIMIT limit_rows) AS picked;
    SELECT count(*)::integer INTO "clearedAppliedBodies" FROM (SELECT 1 FROM app.flow_import_preview WHERE (state = 'DISCARDED' OR (state = 'APPLIED' AND applied_at <= clock_now - INTERVAL '7 days')) AND payload IS NOT NULL ORDER BY COALESCE(applied_at, created_at), id LIMIT limit_rows) AS picked;
    SELECT count(*)::integer INTO "deletedReceipts" FROM (SELECT 1 FROM app.mutation_receipt WHERE expires_at <= clock_now ORDER BY expires_at, id LIMIT limit_rows) AS picked;
    RETURN NEXT;
    RETURN;
  END IF;
  WITH picked AS (SELECT id FROM app.flow_import_preview WHERE state IN ('READY', 'EXPIRED') AND payload IS NOT NULL AND expires_at <= clock_now ORDER BY expires_at, id LIMIT limit_rows FOR UPDATE SKIP LOCKED)
  UPDATE app.flow_import_preview SET state = 'EXPIRED', payload = NULL, positions = NULL, fidelity_report = NULL WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS "expiredPreviews" = ROW_COUNT;
  WITH picked AS (SELECT id FROM app.flow_import_preview WHERE (state = 'DISCARDED' OR (state = 'APPLIED' AND applied_at <= clock_now - INTERVAL '7 days')) AND payload IS NOT NULL ORDER BY COALESCE(applied_at, created_at), id LIMIT limit_rows FOR UPDATE SKIP LOCKED)
  UPDATE app.flow_import_preview SET payload = NULL, positions = NULL, fidelity_report = NULL WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS "clearedAppliedBodies" = ROW_COUNT;
  WITH picked AS (SELECT id FROM app.mutation_receipt WHERE expires_at <= clock_now ORDER BY expires_at, id LIMIT limit_rows FOR UPDATE SKIP LOCKED)
  DELETE FROM app.mutation_receipt WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS "deletedReceipts" = ROW_COUNT;
  RETURN NEXT;
END;
$$;

ALTER TABLE "app"."flow_import_preview" OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_flow_import_preview"() OWNER TO app_migrator;
ALTER FUNCTION "app"."cleanup_transient"(boolean, integer) OWNER TO app_migrator;
REVOKE ALL ON TYPE "app"."flow_import_state" FROM PUBLIC;
REVOKE ALL ON TABLE "app"."flow_import_preview" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."enforce_flow_import_preview"(), "app"."cleanup_transient"(boolean, integer) FROM PUBLIC;
GRANT USAGE ON TYPE "app"."flow_import_state" TO app_web;
GRANT SELECT, INSERT ON "app"."flow_import_preview" TO app_web;
GRANT UPDATE ("state", "applied_at", "result_flow_id", "applied_mapping", "applied_result") ON "app"."flow_import_preview" TO app_web;
