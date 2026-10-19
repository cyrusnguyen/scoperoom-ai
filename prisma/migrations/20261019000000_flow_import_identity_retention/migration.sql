-- Discarded and expired import previews no longer count against their creator for ever (2026-10-19). Only an APPLIED preview is a
-- permanent operation identity. Every receipt that could replay a discarded or expired preview is gone 30 days after it was written,
-- and both were written before the preview's 24-hour expiry, so the sweep deletes those rows once they are 30 days past expiry.
-- The row quota then counts applied imports plus recent previews. The result gains "deletedPreviews"; the other steps are unchanged.
DROP FUNCTION "app"."run_worker_cleanup"(uuid, integer);
DROP FUNCTION "app"."cleanup_transient"(boolean, integer);
CREATE FUNCTION "app"."cleanup_transient"(p_dry_run boolean, p_batch_size integer)
RETURNS TABLE("expiredPreviews" integer, "clearedAppliedBodies" integer, "deletedReceipts" integer, "expiredAiResults" integer, "clearedAiBodies" integer, "deletedPreviews" integer)
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
    SELECT count(*)::integer INTO "deletedPreviews" FROM (SELECT 1 FROM app.flow_import_preview WHERE state IN ('DISCARDED', 'EXPIRED') AND payload IS NULL AND expires_at <= clock_now - INTERVAL '30 days' ORDER BY expires_at, id LIMIT limit_rows) AS picked;
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
  -- A body still present (an EXPIRED row the first step has not reached) keeps its row until a later sweep clears it.
  WITH picked AS (SELECT id FROM app.flow_import_preview WHERE state IN ('DISCARDED', 'EXPIRED') AND payload IS NULL AND expires_at <= clock_now - INTERVAL '30 days' ORDER BY expires_at, id LIMIT limit_rows FOR UPDATE SKIP LOCKED)
  DELETE FROM app.flow_import_preview WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS "deletedPreviews" = ROW_COUNT;
  RETURN NEXT;
END;
$$;

-- Unchanged apart from the result row; recreated because it returns cleanup_transient's row type.
CREATE FUNCTION "app"."run_worker_cleanup"(p_environment_id uuid, p_batch_size integer)
RETURNS TABLE("expiredPreviews" integer, "clearedAppliedBodies" integer, "deletedReceipts" integer, "expiredAiResults" integer, "clearedAiBodies" integer, "deletedPreviews" integer)
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
