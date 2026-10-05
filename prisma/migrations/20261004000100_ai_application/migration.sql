-- One permanent reviewed group consumes a run independently of transient bodies and receipts.
ALTER TABLE app.ai_run ADD CONSTRAINT ai_run_project_id_key UNIQUE (project_id, id);
CREATE TABLE app.ai_suggestion_application (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, draft_id uuid NOT NULL, actor_id uuid NOT NULL,
  prompt_source_version_id uuid NOT NULL, result_hash char(64) NOT NULL,
  selected_operations jsonb NOT NULL, actual_operations jsonb NOT NULL, id_map jsonb NOT NULL, created_id_map jsonb NOT NULL,
  evidence jsonb NOT NULL, source_version_ids uuid[] NOT NULL,
  before_document_revision integer NOT NULL, after_document_revision integer NOT NULL,
  before_layout_revision integer NOT NULL, after_layout_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_application_run_key UNIQUE (run_id), CONSTRAINT ai_application_project_id_key UNIQUE (project_id, id),
  CONSTRAINT ai_application_project_fkey FOREIGN KEY (project_id) REFERENCES app.project(id) ON DELETE CASCADE,
  CONSTRAINT ai_application_run_fkey FOREIGN KEY (project_id, run_id) REFERENCES app.ai_run(project_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_application_draft_fkey FOREIGN KEY (project_id, draft_id) REFERENCES app.scope_draft(project_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_application_actor_fkey FOREIGN KEY (actor_id) REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  CONSTRAINT ai_application_prompt_fkey FOREIGN KEY (project_id, prompt_source_version_id) REFERENCES app.source_version(project_id, id),
  CONSTRAINT ai_application_bounds CHECK (
    result_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(selected_operations) = 'array' AND jsonb_array_length(selected_operations) BETWEEN 1 AND 100
    AND jsonb_typeof(actual_operations) = 'array' AND jsonb_array_length(actual_operations) = jsonb_array_length(selected_operations)
    AND octet_length(selected_operations::text) <= 131072 AND octet_length(actual_operations::text) <= 262144
    AND jsonb_typeof(id_map) = 'object' AND octet_length(id_map::text) <= 65536
    AND jsonb_typeof(created_id_map) = 'object' AND octet_length(created_id_map::text) <= 65536
    AND jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 1048576
    AND cardinality(source_version_ids) BETWEEN 1 AND 201
    AND before_document_revision BETWEEN 1 AND 2147483647 AND after_document_revision BETWEEN before_document_revision AND before_document_revision::bigint + 1
    AND before_layout_revision BETWEEN 1 AND 2147483647 AND after_layout_revision BETWEEN before_layout_revision AND before_layout_revision::bigint + 1)
);
CREATE TABLE app.ai_application_source (
  project_id uuid NOT NULL, application_id uuid NOT NULL, source_version_id uuid NOT NULL,
  PRIMARY KEY (application_id, source_version_id),
  CONSTRAINT ai_application_source_application_fkey FOREIGN KEY (project_id, application_id) REFERENCES app.ai_suggestion_application(project_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_application_source_version_fkey FOREIGN KEY (project_id, source_version_id) REFERENCES app.source_version(project_id, id)
);
CREATE FUNCTION app.enforce_ai_application() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE run app.ai_run%ROWTYPE; expected uuid[];
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE project_id = NEW.project_id AND id = NEW.run_id;
  IF NOT FOUND OR run.state <> 'SUCCEEDED' OR run.disposition <> 'AVAILABLE' OR run.cancel_requested_at IS NOT NULL
    OR run.capture IS NULL OR run.result IS NULL OR run.result->>'kind' <> 'proposal'
    OR run.terminal_at <= clock_timestamp() - INTERVAL '7 days'
    OR NEW.draft_id <> run.draft_id OR NEW.result_hash <> run.result_hash OR NEW.prompt_source_version_id <> run.prompt_source_version_id
    OR NEW.before_document_revision <> run.expected_document_revision THEN
    RAISE EXCEPTION 'AI application does not match available run' USING ERRCODE = '23514';
  END IF;
  SELECT array_agg(DISTINCT source_id ORDER BY source_id) INTO expected FROM (
    SELECT run.prompt_source_version_id AS source_id
    UNION ALL SELECT (source->>'sourceVersionId')::uuid FROM jsonb_array_elements(run.capture->'sources') source
    UNION ALL SELECT (source->>'expectedCurrentVersionId')::uuid FROM jsonb_array_elements(run.capture->'sources') source
  ) sources;
  IF NEW.source_version_ids IS DISTINCT FROM expected THEN RAISE EXCEPTION 'AI application source manifest differs' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION app.enforce_ai_application_sources() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE retained uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.ai_suggestion_application WHERE id = NEW.id) THEN RETURN NULL; END IF;
  SELECT array_agg(source_version_id ORDER BY source_version_id) INTO retained FROM app.ai_application_source WHERE application_id = NEW.id;
  IF retained IS DISTINCT FROM NEW.source_version_ids THEN RAISE EXCEPTION 'AI application source evidence incomplete' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.ai_run WHERE project_id = NEW.project_id AND id = NEW.run_id AND disposition = 'APPLIED') THEN
    RAISE EXCEPTION 'AI application requires consumed run' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION app.enforce_ai_application_source() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.ai_suggestion_application WHERE project_id = NEW.project_id AND id = NEW.application_id AND NEW.source_version_id = ANY(source_version_ids)) THEN
    RAISE EXCEPTION 'AI source outside application manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION app.enforce_ai_application_disposition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.disposition IS DISTINCT FROM OLD.disposition AND NEW.disposition IN ('APPLIED', 'DISCARDED') THEN
    IF OLD.state <> 'SUCCEEDED' OR OLD.disposition <> 'AVAILABLE' OR OLD.cancel_requested_at IS NOT NULL
      OR OLD.terminal_at <= clock_timestamp() - INTERVAL '7 days' THEN
      RAISE EXCEPTION 'AI result unavailable' USING ERRCODE = '23514';
    END IF;
    IF NEW.disposition = 'APPLIED' AND NOT EXISTS (SELECT 1 FROM app.ai_suggestion_application WHERE project_id = OLD.project_id AND run_id = OLD.id) THEN
      RAISE EXCEPTION 'AI application evidence required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enforce_ai_application BEFORE INSERT ON app.ai_suggestion_application FOR EACH ROW EXECUTE FUNCTION app.enforce_ai_application();
CREATE TRIGGER immutable_ai_application BEFORE UPDATE ON app.ai_suggestion_application FOR EACH ROW EXECUTE FUNCTION app.reject_source_version_update();
CREATE TRIGGER immutable_ai_application_source BEFORE UPDATE ON app.ai_application_source FOR EACH ROW EXECUTE FUNCTION app.reject_source_version_update();
CREATE TRIGGER enforce_ai_application_source BEFORE INSERT ON app.ai_application_source FOR EACH ROW EXECUTE FUNCTION app.enforce_ai_application_source();
CREATE CONSTRAINT TRIGGER enforce_ai_application_sources AFTER INSERT ON app.ai_suggestion_application DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.enforce_ai_application_sources();
CREATE TRIGGER enforce_ai_application_disposition BEFORE UPDATE ON app.ai_run FOR EACH ROW EXECUTE FUNCTION app.enforce_ai_application_disposition();
ALTER TABLE app.ai_suggestion_application OWNER TO app_migrator;
ALTER TABLE app.ai_application_source OWNER TO app_migrator;
ALTER FUNCTION app.enforce_ai_application() OWNER TO app_migrator;
ALTER FUNCTION app.enforce_ai_application_sources() OWNER TO app_migrator;
ALTER FUNCTION app.enforce_ai_application_source() OWNER TO app_migrator;
ALTER FUNCTION app.enforce_ai_application_disposition() OWNER TO app_migrator;
REVOKE ALL ON TABLE app.ai_suggestion_application, app.ai_application_source FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_ai_application(), app.enforce_ai_application_sources(), app.enforce_ai_application_disposition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_ai_application_source() FROM PUBLIC;
GRANT SELECT, INSERT ON app.ai_suggestion_application, app.ai_application_source TO app_web;
GRANT SELECT ON app.ai_suggestion_application, app.ai_application_source TO app_worker;
GRANT UPDATE (disposition) ON app.ai_run TO app_web;

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
  -- Bodies leave only seven days after settlement. Applied bodies need permanent application evidence first.
  IF ((OLD.capture IS NOT NULL AND NEW.capture IS NULL) OR (OLD.result IS NOT NULL AND NEW.result IS NULL))
    AND (OLD.terminal_at IS NULL OR OLD.terminal_at > CURRENT_TIMESTAMP - INTERVAL '7 days' OR (OLD.disposition = 'APPLIED' AND NOT EXISTS (SELECT 1 FROM app.ai_suggestion_application WHERE project_id = OLD.project_id AND run_id = OLD.id))) THEN
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
    FROM (SELECT disposition FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND (disposition IS DISTINCT FROM 'APPLIED' OR EXISTS (SELECT 1 FROM app.ai_suggestion_application application WHERE application.run_id = ai_run.id AND application.project_id = ai_run.project_id)) ORDER BY project_id, id LIMIT limit_rows) AS picked;
    RETURN NEXT; RETURN;
  END IF;
  FOR candidate IN SELECT id, project_id FROM app.ai_run WHERE terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND (disposition IS DISTINCT FROM 'APPLIED' OR EXISTS (SELECT 1 FROM app.ai_suggestion_application application WHERE application.run_id = ai_run.id AND application.project_id = ai_run.project_id)) ORDER BY project_id, id LIMIT limit_rows LOOP
    PERFORM 1 FROM app.project WHERE id = candidate.project_id FOR NO KEY UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO run FROM app.ai_run WHERE id = candidate.id AND terminal_at <= cutoff AND (capture IS NOT NULL OR result IS NOT NULL) AND (disposition IS DISTINCT FROM 'APPLIED' OR EXISTS (SELECT 1 FROM app.ai_suggestion_application application WHERE application.run_id = ai_run.id AND application.project_id = ai_run.project_id)) FOR UPDATE SKIP LOCKED;
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
