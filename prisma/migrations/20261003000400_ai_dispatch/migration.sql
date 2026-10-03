-- Stage 06.1 fenced execution: durable dispatch leases and the validating step, as narrow definer functions. Runtime roles never
-- hold UPDATE on the dispatch columns (the Task 1 worker column grants are revoked here); web and worker only call these.
REVOKE UPDATE ("dispatch_state", "task_id", "dispatch_lease_until", "next_dispatch_at") ON "app"."ai_run" FROM app_worker;

-- Leases due PENDING dispatches (one run, or a bounded batch) with an expiring lease and returns what must be delivered. Delivery
-- happens outside this transaction. A run that is cancelled, past its deadline, already acknowledged or under a live lease is skipped;
-- SKIP LOCKED means a busy run is left to the next sweep rather than waited on. Only the run row is locked, never project or owner rows.
CREATE FUNCTION "app"."lease_ai_dispatches"(p_run_id uuid, p_batch integer, p_lease_seconds integer)
RETURNS TABLE ("out_run_id" uuid, "out_dispatch_id" uuid, "out_execution_binding" text, "out_deadline_at" timestamptz, "out_lease" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  clock_now timestamptz := clock_timestamp();
  lease_until timestamptz := clock_timestamp() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 5), 120));
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT run.id FROM app.ai_run AS run
    WHERE (p_run_id IS NULL OR run.id = p_run_id) AND run.dispatch_state = 'PENDING' AND run.state = 'QUEUED' AND run.cancel_requested_at IS NULL
      AND run.deadline_at > clock_now AND (run.dispatch_lease_until IS NULL OR run.dispatch_lease_until <= clock_now)
      AND COALESCE(run.next_dispatch_at, run.created_at) <= clock_now
    ORDER BY COALESCE(run.next_dispatch_at, run.created_at), run.id LIMIT LEAST(GREATEST(p_batch, 1), 100) FOR UPDATE OF run SKIP LOCKED
  )
  UPDATE app.ai_run AS run SET dispatch_lease_until = lease_until FROM due WHERE run.id = due.id
  RETURNING run.id, run.dispatch_id, run.execution_binding, run.deadline_at, lease_until::text;
END;
$$;

-- Records a delivery acknowledgement only for the lease this caller holds (the exact lease text it was given). A lost or stale
-- acknowledgement changes nothing and leaves the run PENDING; the taskId is final once recorded.
CREATE FUNCTION "app"."ack_ai_dispatch"(p_run_id uuid, p_dispatch_id uuid, p_lease text, p_task_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE app.ai_run SET dispatch_state = 'DISPATCHED', task_id = p_task_id, dispatch_lease_until = NULL
  WHERE id = p_run_id AND dispatch_id = p_dispatch_id AND dispatch_state = 'PENDING' AND dispatch_lease_until = p_lease::timestamptz;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

-- RUNNING -> VALIDATING for the current attempt, so a duplicate delivery finds the run busy while the reply is validated. It
-- refuses (FENCED) a reply that arrives after cancellation, the attempt window or loss of authority, exactly like the settlement.
CREATE FUNCTION "app"."begin_ai_validation"(p_run_id uuid, p_attempt_id uuid, p_attempt_token uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  attempt app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  SELECT * INTO attempt FROM app.ai_run_attempt WHERE id = p_attempt_id AND run_id = p_run_id AND token = p_attempt_token FOR UPDATE;
  IF NOT FOUND OR attempt.outcome IS NOT NULL OR run.current_attempt_id IS DISTINCT FROM attempt.id OR run.terminal_at IS NOT NULL OR run.state <> 'RUNNING' THEN RETURN 'STALE'; END IF;
  IF run.cancel_requested_at IS NOT NULL OR clock_now >= attempt.deadline_at OR NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN RETURN 'FENCED'; END IF;
  UPDATE app.ai_run SET state = 'VALIDATING' WHERE id = run.id;
  RETURN 'VALIDATING';
END;
$$;

ALTER FUNCTION "app"."lease_ai_dispatches"(uuid, integer, integer) OWNER TO app_migrator;
ALTER FUNCTION "app"."ack_ai_dispatch"(uuid, uuid, text, text) OWNER TO app_migrator;
ALTER FUNCTION "app"."begin_ai_validation"(uuid, uuid, uuid) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."lease_ai_dispatches"(uuid, integer, integer), "app"."ack_ai_dispatch"(uuid, uuid, text, text), "app"."begin_ai_validation"(uuid, uuid, uuid) FROM PUBLIC;
-- Web delivers the first dispatch after its admission commit; the worker repairs. Only the worker validates replies.
GRANT EXECUTE ON FUNCTION "app"."lease_ai_dispatches"(uuid, integer, integer), "app"."ack_ai_dispatch"(uuid, uuid, text, text) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION "app"."begin_ai_validation"(uuid, uuid, uuid) TO app_worker;
