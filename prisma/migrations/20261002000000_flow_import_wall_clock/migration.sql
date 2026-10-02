CREATE OR REPLACE FUNCTION "app"."enforce_flow_import_preview"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.format_version IS DISTINCT FROM OLD.format_version OR NEW.expected_document_revision IS DISTINCT FROM OLD.expected_document_revision
    OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'flow import identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.payload IS NULL AND NEW.payload IS NOT NULL) OR (OLD.payload IS NOT NULL AND NEW.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload)
    OR (OLD.positions IS NULL AND NEW.positions IS NOT NULL) OR (OLD.positions IS NOT NULL AND NEW.positions IS NOT NULL AND NEW.positions IS DISTINCT FROM OLD.positions)
    OR (OLD.fidelity_report IS NULL AND NEW.fidelity_report IS NOT NULL) OR (OLD.fidelity_report IS NOT NULL AND NEW.fidelity_report IS NOT NULL AND NEW.fidelity_report IS DISTINCT FROM OLD.fidelity_report) THEN
    RAISE EXCEPTION 'flow import body is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'READY' THEN
    IF NEW.state NOT IN ('READY', 'DISCARDED', 'EXPIRED', 'APPLIED') THEN RAISE EXCEPTION 'invalid flow import transition' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'APPLIED' AND OLD.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'flow import expired' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'EXPIRED' AND OLD.expires_at > clock_timestamp() THEN RAISE EXCEPTION 'flow import not expired' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal flow import state is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.payload IS NOT NULL AND NEW.payload IS NULL AND (NEW.state = 'READY' OR (NEW.state = 'APPLIED' AND NEW.applied_at > CURRENT_TIMESTAMP - INTERVAL '7 days')) THEN
    RAISE EXCEPTION 'flow import body retention boundary' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'APPLIED' AND (NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.result_flow_id IS DISTINCT FROM OLD.result_flow_id
    OR NEW.applied_mapping IS DISTINCT FROM OLD.applied_mapping OR NEW.applied_result IS DISTINCT FROM OLD.applied_result) THEN
    RAISE EXCEPTION 'applied flow import result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
