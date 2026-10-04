-- Every externally visible run-state transition advances the AI cursor in its own guarded transaction.
-- Existing function owners and grants survive CREATE OR REPLACE.

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
  ELSIF NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN out_status := 'DENIED';
  END IF;
  IF out_status IS NOT NULL THEN RETURN NEXT; RETURN; END IF;
  IF run.current_attempt_id IS NOT NULL THEN
    -- Validation has no separate lease: its current attempt stays BUSY until reported or its window closes.
    -- An abandoned attempt is UNKNOWN and remains consumed; recovery needs a fresh second claim below.
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
  IF run.state IN ('QUEUED', 'VALIDATING') THEN
    PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_STARTED', jsonb_build_object('state', 'RUNNING'));
  END IF;
  out_status := 'CLAIMED'; out_attempt_id := claimed.id; out_attempt_number := claimed.attempt_number; out_attempt_token := claimed.token; out_attempt_deadline_at := claimed.deadline_at;
  RETURN NEXT;
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
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_VALIDATING', jsonb_build_object('state', 'VALIDATING'));
  RETURN 'VALIDATING';
END;
$$;
