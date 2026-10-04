-- Preserve reported model-result diagnostics; input rejection checks actor authority before any provider claim.
-- CREATE OR REPLACE preserves the existing owner and restricted execution grants.

CREATE OR REPLACE FUNCTION "app"."finish_ai_run"(p_run_id uuid, p_state "app"."ai_run_state", p_failure_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  clock_now timestamptz;
  final_state app.ai_run_state := p_state;
  final_code text := p_failure_code;
BEGIN
  IF p_state NOT IN ('FAILED', 'CANCELLED', 'TIMED_OUT') THEN RAISE EXCEPTION 'unsupported terminal state' USING ERRCODE = '22023'; END IF;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF run.terminal_at IS NOT NULL THEN RETURN 'TERMINAL'; END IF;
  PERFORM 1 FROM app.ai_run_attempt WHERE run_id = run.id ORDER BY attempt_number FOR UPDATE;
  IF run.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = run.owner_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'MISSING'; END IF;
    PERFORM 1 FROM app.ai_budget_day WHERE owner_id = run.owner_id AND day = run.admission_day FOR UPDATE;
    IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  END IF;
  -- All potentially blocking authority/accounting locks precede this decision. Input rejection cannot outrank committed fences.
  clock_now := clock_timestamp();
  IF p_state = 'FAILED' THEN
    IF run.cancel_requested_at IS NOT NULL THEN final_state := 'CANCELLED'; final_code := NULL;
    ELSIF clock_now >= run.deadline_at THEN final_state := 'TIMED_OUT'; final_code := NULL;
    ELSIF p_failure_code = 'INPUT_TOO_LARGE' AND NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN final_code := 'ACCESS_REVOKED';
    END IF;
  END IF;
  IF (final_state = 'CANCELLED' AND (run.cancel_requested_at IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE run_id = run.id AND outcome IS NULL AND deadline_at > clock_now)))
    OR (final_state = 'TIMED_OUT' AND clock_now < run.deadline_at)
    OR (final_state = 'FAILED' AND (final_code IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE id = run.current_attempt_id AND outcome IS NULL))) THEN
    RETURN 'REFUSED';
  END IF;
  IF final_state <> 'FAILED' THEN
    UPDATE app.ai_run_attempt SET outcome = CASE final_state WHEN 'CANCELLED' THEN 'UNKNOWN'::app.ai_attempt_outcome ELSE 'TIMED_OUT'::app.ai_attempt_outcome END, settled_at = clock_now
    WHERE run_id = run.id AND outcome IS NULL;
  END IF;
  IF run.budget_state = 'RESERVED' THEN
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  UPDATE app.ai_run SET state = final_state, failure_code = final_code, terminal_at = clock_now,
    budget_state = CASE WHEN run.budget_state = 'RESERVED' THEN 'RELEASED'::app.ai_budget_state ELSE run.budget_state END WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_' || final_state::text, jsonb_build_object('state', final_state::text));
  RETURN 'SETTLED';
END;
$$;
