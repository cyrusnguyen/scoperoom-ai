-- Bind the immutable AI capture to its actual parent now that approved baselines exist.
CREATE OR REPLACE FUNCTION "app"."enforce_ai_run_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- The runtime roles never choose the admission clock: time, UTC day and the 300 second deadline come from this transaction.
  IF current_user IN ('app_web', 'app_worker') THEN
    NEW.created_at := transaction_timestamp();
    NEW.admission_day := (NEW.created_at AT TIME ZONE 'UTC')::date;
    NEW.deadline_at := NEW.created_at + INTERVAL '300 seconds';
  END IF;
  IF NEW.state <> 'QUEUED' OR NEW.disposition IS NOT NULL OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL OR NEW.diff IS NOT NULL
    OR NEW.failure_code IS NOT NULL OR NEW.dispatch_state <> 'PENDING' OR NEW.task_id IS NOT NULL OR NEW.dispatch_lease_until IS NOT NULL
    OR NEW.current_attempt_id IS NOT NULL OR NEW.budget_state <> 'RESERVED' OR NEW.cancel_requested_at IS NOT NULL OR NEW.terminal_at IS NOT NULL
    OR NEW.capture IS NULL OR jsonb_typeof(NEW.capture) <> 'object' THEN
    RAISE EXCEPTION 'an AI run starts queued with no result' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.project AS project WHERE project.id = NEW.project_id AND project.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'an AI run is charged to its project owner' USING ERRCODE = '23514';
  END IF;
  IF NEW.capture->>'taskType' IS DISTINCT FROM NEW.task_type::text OR NEW.capture->>'draftId' IS DISTINCT FROM NEW.draft_id::text
    OR NEW.capture->>'documentRevision' IS DISTINCT FROM NEW.expected_document_revision::text OR NEW.capture->'parentSnapshotId' IS DISTINCT FROM COALESCE(to_jsonb(NEW.parent_snapshot_id::text), 'null'::jsonb)
    OR NEW.capture->'versions'->>'model' IS DISTINCT FROM NEW.model THEN
    RAISE EXCEPTION 'AI run capture identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.source_version AS version
    JOIN app.source_document AS source ON source.project_id = version.project_id AND source.id = version.source_id
    WHERE version.project_id = NEW.project_id AND version.id = NEW.prompt_source_version_id AND source.kind = 'AI_PROMPT'
      AND version.created_by = NEW.actor_id AND version.text = NEW.capture->>'prompt' AND version.content_hash = NEW.capture->>'promptHash'
  ) THEN
    RAISE EXCEPTION 'AI run prompt evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
