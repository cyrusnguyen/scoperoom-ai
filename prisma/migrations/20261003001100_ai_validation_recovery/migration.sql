-- Recover a process lost during validation using the same bounded attempt authority as RUNNING.
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
  IF run.state = 'QUEUED' THEN PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_STARTED', jsonb_build_object('state', 'RUNNING')); END IF;
  out_status := 'CLAIMED'; out_attempt_id := claimed.id; out_attempt_number := claimed.attempt_number; out_attempt_token := claimed.token; out_attempt_deadline_at := claimed.deadline_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION "app"."enforce_ai_run"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_number integer;
  new_number integer;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.admission_day IS DISTINCT FROM OLD.admission_day
    OR NEW.prompt_source_version_id IS DISTINCT FROM OLD.prompt_source_version_id OR NEW.task_type IS DISTINCT FROM OLD.task_type
    OR NEW.model IS DISTINCT FROM OLD.model OR NEW.execution_binding IS DISTINCT FROM OLD.execution_binding OR NEW.capture_hash IS DISTINCT FROM OLD.capture_hash
    OR NEW.expected_document_revision IS DISTINCT FROM OLD.expected_document_revision OR NEW.parent_snapshot_id IS DISTINCT FROM OLD.parent_snapshot_id
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI run identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.capture IS NULL AND NEW.capture IS NOT NULL) OR (OLD.capture IS NOT NULL AND NEW.capture IS NOT NULL AND NEW.capture IS DISTINCT FROM OLD.capture)
    OR (OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.result IS NULL AND NEW.result IS NOT NULL AND OLD.state = 'SUCCEEDED')
    OR (OLD.result_hash IS NOT NULL AND NEW.result_hash IS DISTINCT FROM OLD.result_hash)
    OR (OLD.diff IS NOT NULL AND NEW.diff IS NOT NULL AND NEW.diff IS DISTINCT FROM OLD.diff) THEN
    RAISE EXCEPTION 'AI run capture and result are immutable' USING ERRCODE = '23514';
  END IF;
  -- Bodies leave only seven days after the run settled, and never from an applied run (its evidence must survive cleanup).
  IF ((OLD.capture IS NOT NULL AND NEW.capture IS NULL) OR (OLD.result IS NOT NULL AND NEW.result IS NULL))
    AND (OLD.terminal_at IS NULL OR OLD.terminal_at > CURRENT_TIMESTAMP - INTERVAL '7 days' OR OLD.disposition = 'APPLIED') THEN
    RAISE EXCEPTION 'AI run body retention boundary' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
    OR (OLD.state = 'RUNNING' AND NEW.state IN ('VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
    OR (OLD.state = 'VALIDATING' AND NEW.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
    OR (OLD.state = 'VALIDATING' AND NEW.state = 'RUNNING' AND NEW.budget_state = 'CONSUMED'
      AND NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id AND EXISTS (
        SELECT 1 FROM app.ai_run_attempt AS prior JOIN app.ai_run_attempt AS current ON current.run_id = prior.run_id
        WHERE prior.run_id = OLD.id AND prior.id = OLD.current_attempt_id AND prior.attempt_number = 1
          AND prior.outcome IS NOT NULL AND prior.settled_at IS NOT NULL
          AND current.id = NEW.current_attempt_id AND current.attempt_number = 2
          AND current.outcome IS NULL AND current.settled_at IS NULL AND current.call_may_have_started
          AND current.deadline_at > clock_timestamp() AND current.deadline_at <= NEW.deadline_at))
  ) THEN
    RAISE EXCEPTION 'invalid AI run transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.terminal_at IS NOT NULL AND (NEW.terminal_at IS DISTINCT FROM OLD.terminal_at OR NEW.failure_code IS DISTINCT FROM OLD.failure_code) THEN
    RAISE EXCEPTION 'terminal AI run is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.disposition IS NOT NULL AND NEW.disposition IS DISTINCT FROM OLD.disposition AND OLD.disposition <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'AI result disposition is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    RAISE EXCEPTION 'AI run cancellation intent is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.budget_state <> 'RESERVED' AND NEW.budget_state IS DISTINCT FROM OLD.budget_state THEN
    RAISE EXCEPTION 'AI run budget settlement is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_state = 'DISPATCHED' AND (NEW.dispatch_state <> 'DISPATCHED' OR NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    RAISE EXCEPTION 'AI run dispatch acknowledgement is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id AND OLD.current_attempt_id IS NOT NULL THEN
    SELECT attempt_number INTO old_number FROM app.ai_run_attempt WHERE id = OLD.current_attempt_id;
    SELECT attempt_number INTO new_number FROM app.ai_run_attempt WHERE id = NEW.current_attempt_id;
    IF new_number IS NULL OR new_number <= old_number THEN
      RAISE EXCEPTION 'the current attempt pointer only advances' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
