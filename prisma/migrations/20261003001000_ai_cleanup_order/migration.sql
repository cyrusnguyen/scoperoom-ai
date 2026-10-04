-- Dry-run and apply must select the same deterministic bounded batch when there is no lock contention.
-- Preserve project-first apply ordering and its SKIP LOCKED parent guard by aligning the dry-run selection.
-- Shared cleanup may already hold preview/receipt child locks. Never wait for their parent project: an application mutation or
-- project deletion holds the project first and may be waiting for that same child. Busy projects are left to the next scheduled tick.
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
    FROM (SELECT disposition FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY project_id, id LIMIT limit_rows) AS picked;
    RETURN NEXT; RETURN;
  END IF;
  FOR candidate IN SELECT id, project_id FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY project_id, id LIMIT limit_rows LOOP
    PERFORM 1 FROM app.project WHERE id = candidate.project_id FOR NO KEY UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
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
