-- Stage 06.1 retention: AI body expiry joins the one bounded transient sweep, and the scheduled worker reaches it through one narrow,
-- environment-validated function. The operator sweep (bootstrap credential, loopback only) is unchanged; no runtime role gets the
-- sweep, the table writes or bootstrap rights.

-- The cutoff is the transaction clock, which is the boundary the enforce_ai_run retention trigger checks. A statement clock a few
-- microseconds later could otherwise pick a run the trigger still protects and abort the whole batch.
CREATE OR REPLACE FUNCTION "app"."expire_ai_run_bodies"(p_dry_run boolean, p_batch_size integer)
RETURNS TABLE ("expiredResults" integer, "clearedBodies" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  limit_rows integer := LEAST(GREATEST(p_batch_size, 1), 100);
  cutoff timestamptz := transaction_timestamp() - INTERVAL '7 days';
  candidate record;
  run app.ai_run%ROWTYPE;
BEGIN
  PERFORM set_config('statement_timeout', '5000', true);
  "expiredResults" := 0; "clearedBodies" := 0;
  IF p_dry_run THEN
    SELECT count(*) FILTER (WHERE disposition = 'AVAILABLE')::integer, count(*) FILTER (WHERE disposition IS DISTINCT FROM 'AVAILABLE')::integer INTO "expiredResults", "clearedBodies"
    FROM (SELECT disposition FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY terminal_at, id LIMIT limit_rows) AS picked;
    RETURN NEXT; RETURN;
  END IF;
  -- Project order first, so concurrent sweeps and the lifecycle functions acquire locks in one order.
  FOR candidate IN SELECT id, project_id FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY project_id, id LIMIT limit_rows LOOP
    PERFORM 1 FROM app.project WHERE id = candidate.project_id FOR NO KEY UPDATE;
    SELECT * INTO run FROM app.ai_run WHERE id = candidate.id AND terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE app.ai_run SET capture = NULL, result = NULL, diff = NULL, disposition = CASE WHEN run.disposition = 'AVAILABLE' THEN 'EXPIRED'::app.ai_result_disposition ELSE run.disposition END WHERE id = run.id;
    IF run.disposition = 'AVAILABLE' THEN
      "expiredResults" := "expiredResults" + 1;
      PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RESULT_EXPIRED', jsonb_build_object('state', run.state::text));
    ELSE
      "clearedBodies" := "clearedBodies" + 1;
    END IF;
  END LOOP;
  RETURN NEXT;
END;
$$;

-- The existing sweep gains the two AI counts; the preview and receipt steps are unchanged. Nothing else depends on its row type.
DROP FUNCTION "app"."cleanup_transient"(boolean, integer);
CREATE FUNCTION "app"."cleanup_transient"(p_dry_run boolean, p_batch_size integer)
RETURNS TABLE("expiredPreviews" integer, "clearedAppliedBodies" integer, "deletedReceipts" integer, "expiredAiResults" integer, "clearedAiBodies" integer)
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
    SELECT ai."expiredResults", ai."clearedBodies" INTO "expiredAiResults", "clearedAiBodies" FROM app.expire_ai_run_bodies(true, limit_rows) AS ai;
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
  SELECT ai."expiredResults", ai."clearedBodies" INTO "expiredAiResults", "clearedAiBodies" FROM app.expire_ai_run_bodies(false, limit_rows) AS ai;
  RETURN NEXT;
END;
$$;

-- The scheduled worker's only maintenance door. It proves the database is the environment this process was configured for, bounds the
-- batch, and runs the same sweep as the operator command. It cannot dry-run, choose other work or read anything back.
CREATE FUNCTION "app"."run_worker_cleanup"(p_environment_id uuid, p_batch_size integer)
RETURNS TABLE("expiredPreviews" integer, "clearedAppliedBodies" integer, "deletedReceipts" integer, "expiredAiResults" integer, "clearedAiBodies" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN RAISE EXCEPTION 'batch size must be between 1 and 100' USING ERRCODE = '22023'; END IF;
  IF p_environment_id IS NULL OR NOT EXISTS (SELECT 1 FROM app.environment_identity WHERE id = 1 AND environment_id = p_environment_id) THEN
    RAISE EXCEPTION 'maintenance rejected environment identity' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY SELECT * FROM app.cleanup_transient(false, p_batch_size);
END;
$$;

ALTER FUNCTION "app"."cleanup_transient"(boolean, integer) OWNER TO app_migrator;
ALTER FUNCTION "app"."run_worker_cleanup"(uuid, integer) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."cleanup_transient"(boolean, integer), "app"."run_worker_cleanup"(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."run_worker_cleanup"(uuid, integer) TO app_worker;
