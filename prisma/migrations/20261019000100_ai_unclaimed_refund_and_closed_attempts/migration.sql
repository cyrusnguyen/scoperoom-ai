-- Two AI settlement corrections (2026-10-19). CREATE OR REPLACE keeps each function's owner, grants and trigger.
--
-- 1. Deleting a run refunds every RESERVED reservation. A provider call needs a committed claim, and claim_ai_attempt moves the
--    budget from RESERVED to CONSUMED in the transaction that inserts the attempt; DELETE holds the run's row lock, so a run still
--    RESERVED was never claimed and never called. A dispatch or lease alone used to keep the charge.
CREATE OR REPLACE FUNCTION app.settle_deleted_ai_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = OLD.owner_id FOR UPDATE;
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1 WHERE owner_id = OLD.owner_id AND day = OLD.admission_day;
  END IF;
  RETURN OLD;
END;
$$;

-- 2. A FAILED finish waits only for an attempt whose call window is still open, as CANCELLED already did. An attempt whose window
--    closed with no report (a crashed worker) is settled UNKNOWN and stays consumed, so a retry that finds the actor's access
--    revoked records ACCESS_REVOKED at once instead of holding the project's AI slot until the run deadline.
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
    ELSIF p_failure_code IN ('INPUT_TOO_LARGE', 'PROMPT_VERSION_UNSUPPORTED', 'MODEL_UNAVAILABLE') AND NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN final_code := 'ACCESS_REVOKED';
    END IF;
  END IF;
  IF (final_state = 'CANCELLED' AND (run.cancel_requested_at IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE run_id = run.id AND outcome IS NULL AND deadline_at > clock_now)))
    OR (final_state = 'TIMED_OUT' AND clock_now < run.deadline_at)
    OR (final_state = 'FAILED' AND (final_code IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE id = run.current_attempt_id AND outcome IS NULL AND deadline_at > clock_now))) THEN
    RETURN 'REFUSED';
  END IF;
  UPDATE app.ai_run_attempt SET outcome = CASE final_state WHEN 'TIMED_OUT' THEN 'TIMED_OUT'::app.ai_attempt_outcome ELSE 'UNKNOWN'::app.ai_attempt_outcome END, settled_at = clock_now
  WHERE run_id = run.id AND outcome IS NULL;
  IF run.budget_state = 'RESERVED' THEN
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  UPDATE app.ai_run SET state = final_state, failure_code = final_code, terminal_at = clock_now,
    budget_state = CASE WHEN run.budget_state = 'RESERVED' THEN 'RELEASED'::app.ai_budget_state ELSE run.budget_state END WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_' || final_state::text, jsonb_build_object('state', final_state::text));
  RETURN 'SETTLED';
END;
$$;
