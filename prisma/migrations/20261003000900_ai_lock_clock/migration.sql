-- Blocking lock waits cannot extend provider-call or result authority. Refresh wall time after relevant locks.
-- CREATE OR REPLACE preserves the existing owner and grants.

CREATE OR REPLACE FUNCTION "app"."claim_ai_attempt"(p_run_id uuid)
RETURNS TABLE ("out_status" text, "out_attempt_id" uuid, "out_attempt_number" integer, "out_attempt_token" uuid, "out_attempt_deadline_at" timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  prior app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz;
  next_number integer := 1;
  claimed app.ai_run_attempt%ROWTYPE;
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
  clock_now := clock_timestamp();
  IF run.terminal_at IS NOT NULL THEN out_status := 'TERMINAL';
  ELSIF run.cancel_requested_at IS NOT NULL THEN out_status := 'CANCELLED';
  ELSIF clock_now >= run.deadline_at THEN out_status := 'DEADLINE';
  ELSIF run.state = 'VALIDATING' THEN out_status := 'BUSY';
  ELSIF NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN out_status := 'DENIED';
  END IF;
  IF out_status IS NOT NULL THEN RETURN NEXT; RETURN; END IF;
  IF run.current_attempt_id IS NOT NULL THEN
    SELECT * INTO prior FROM app.ai_run_attempt WHERE id = run.current_attempt_id FOR UPDATE;
    IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
    clock_now := clock_timestamp();
    IF clock_now >= run.deadline_at THEN out_status := 'DEADLINE'; RETURN NEXT; RETURN; END IF;
    IF NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN out_status := 'DENIED'; RETURN NEXT; RETURN; END IF;
    IF prior.outcome IS NULL THEN
      IF prior.deadline_at > clock_now THEN out_status := 'BUSY'; RETURN NEXT; RETURN; END IF;
      -- The previous call's window closed with no reported outcome: it may have run, so it stays consumed and is never repeated.
      UPDATE app.ai_run_attempt SET outcome = 'UNKNOWN', settled_at = clock_now WHERE id = prior.id;
    END IF;
    next_number := prior.attempt_number + 1;
  END IF;
  IF next_number > 2 THEN out_status := 'CEILING'; RETURN NEXT; RETURN; END IF;
  IF run.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = run.owner_id FOR UPDATE;
    IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
    PERFORM 1 FROM app.ai_budget_day WHERE owner_id = run.owner_id AND day = run.admission_day FOR UPDATE;
    IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
  END IF;
  -- The held run lock fences state/cancel changes; entitlement can change during owner/day waits.
  clock_now := clock_timestamp();
  IF run.cancel_requested_at IS NOT NULL THEN out_status := 'CANCELLED';
  ELSIF clock_now >= run.deadline_at THEN out_status := 'DEADLINE';
  ELSIF NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN out_status := 'DENIED';
  END IF;
  IF out_status IS NOT NULL THEN RETURN NEXT; RETURN; END IF;
  IF run.budget_state = 'RESERVED' THEN
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1, consumed_runs = consumed_runs + 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  INSERT INTO app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started)
  VALUES (run.id, next_number, clock_now, LEAST(clock_now + INTERVAL '120 seconds', run.deadline_at), true)
  RETURNING * INTO claimed;
  UPDATE app.ai_run SET state = 'RUNNING', current_attempt_id = claimed.id, budget_state = 'CONSUMED' WHERE id = run.id;
  IF run.state = 'QUEUED' THEN PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_STARTED', jsonb_build_object('state', 'RUNNING')); END IF;
  out_status := 'CLAIMED'; out_attempt_id := claimed.id; out_attempt_number := claimed.attempt_number; out_attempt_token := claimed.token; out_attempt_deadline_at := claimed.deadline_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION "app"."settle_ai_attempt"(
  p_run_id uuid, p_attempt_id uuid, p_attempt_token uuid, p_outcome "app"."ai_attempt_outcome", p_result jsonb, p_result_hash text,
  p_input_tokens integer, p_output_tokens integer, p_request_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  attempt app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz;
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  SELECT * INTO attempt FROM app.ai_run_attempt WHERE id = p_attempt_id AND run_id = p_run_id AND token = p_attempt_token FOR UPDATE;
  IF NOT FOUND OR attempt.outcome IS NOT NULL OR run.current_attempt_id IS DISTINCT FROM attempt.id OR run.terminal_at IS NOT NULL THEN RETURN 'STALE'; END IF;
  clock_now := clock_timestamp();
  UPDATE app.ai_run_attempt SET outcome = p_outcome, settled_at = clock_now, input_tokens = p_input_tokens, output_tokens = p_output_tokens, provider_request_id = p_request_id WHERE id = attempt.id;
  IF p_outcome <> 'COMPLETED' THEN RETURN 'RECORDED'; END IF;
  IF run.cancel_requested_at IS NOT NULL OR clock_now >= run.deadline_at OR clock_now >= attempt.deadline_at OR NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN RETURN 'FENCED'; END IF;
  IF p_result IS NULL OR p_result_hash IS NULL THEN RAISE EXCEPTION 'a completed attempt requires its validated result' USING ERRCODE = '23514'; END IF;
  UPDATE app.ai_run SET state = 'SUCCEEDED', disposition = 'AVAILABLE', result = p_result, result_hash = p_result_hash, terminal_at = clock_now WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_SUCCEEDED', jsonb_build_object('state', 'SUCCEEDED'));
  RETURN 'SUCCEEDED';
END;
$$;

CREATE OR REPLACE FUNCTION "app"."finish_ai_run"(p_run_id uuid, p_state "app"."ai_run_state", p_failure_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  clock_now timestamptz;
BEGIN
  IF p_state NOT IN ('FAILED', 'CANCELLED', 'TIMED_OUT') THEN RAISE EXCEPTION 'unsupported terminal state' USING ERRCODE = '22023'; END IF;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF run.terminal_at IS NOT NULL THEN RETURN 'TERMINAL'; END IF;
  PERFORM 1 FROM app.ai_run_attempt WHERE run_id = run.id ORDER BY attempt_number FOR UPDATE;
  clock_now := clock_timestamp();
  IF (p_state = 'CANCELLED' AND (run.cancel_requested_at IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE run_id = run.id AND outcome IS NULL AND deadline_at > clock_now)))
    OR (p_state = 'TIMED_OUT' AND clock_now < run.deadline_at)
    OR (p_state = 'FAILED' AND (p_failure_code IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE id = run.current_attempt_id AND outcome IS NULL))) THEN
    RETURN 'REFUSED';
  END IF;
  IF p_state <> 'FAILED' THEN
    UPDATE app.ai_run_attempt SET outcome = CASE p_state WHEN 'CANCELLED' THEN 'UNKNOWN'::app.ai_attempt_outcome ELSE 'TIMED_OUT'::app.ai_attempt_outcome END, settled_at = clock_now
    WHERE run_id = run.id AND outcome IS NULL;
  END IF;
  IF run.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = run.owner_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'MISSING'; END IF;
    PERFORM 1 FROM app.ai_budget_day WHERE owner_id = run.owner_id AND day = run.admission_day FOR UPDATE;
    IF NOT FOUND THEN RETURN 'MISSING'; END IF;
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  clock_now := clock_timestamp();
  UPDATE app.ai_run SET state = p_state, failure_code = p_failure_code, terminal_at = clock_now,
    budget_state = CASE WHEN run.budget_state = 'RESERVED' THEN 'RELEASED'::app.ai_budget_state ELSE run.budget_state END WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_' || p_state::text, jsonb_build_object('state', p_state::text));
  RETURN 'SETTLED';
END;
$$;

CREATE OR REPLACE FUNCTION "app"."begin_ai_validation"(p_run_id uuid, p_attempt_id uuid, p_attempt_token uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  attempt app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz;
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  SELECT * INTO attempt FROM app.ai_run_attempt WHERE id = p_attempt_id AND run_id = p_run_id AND token = p_attempt_token FOR UPDATE;
  IF NOT FOUND OR attempt.outcome IS NOT NULL OR run.current_attempt_id IS DISTINCT FROM attempt.id OR run.terminal_at IS NOT NULL OR run.state <> 'RUNNING' THEN RETURN 'STALE'; END IF;
  clock_now := clock_timestamp();
  IF run.cancel_requested_at IS NOT NULL OR clock_now >= run.deadline_at OR clock_now >= attempt.deadline_at OR NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN RETURN 'FENCED'; END IF;
  UPDATE app.ai_run SET state = 'VALIDATING' WHERE id = run.id;
  RETURN 'VALIDATING';
END;
$$;
