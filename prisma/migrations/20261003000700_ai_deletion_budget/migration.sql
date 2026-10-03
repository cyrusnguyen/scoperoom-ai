-- Deletion must settle the original owner/day reservation without recreating a run or its bodies.
-- The row lock held by DELETE fences claims; a project cascade already holds the project lock.
CREATE FUNCTION app.settle_deleted_ai_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  uncertain boolean;
BEGIN
  IF OLD.budget_state = 'RESERVED' THEN
    -- PENDING after a leased delivery can hide a lost acknowledgement. Refund only when no dispatch or claim could have started.
    uncertain := OLD.dispatch_state <> 'PENDING' OR OLD.task_id IS NOT NULL OR OLD.dispatch_lease_until IS NOT NULL
      OR OLD.next_dispatch_at IS NOT NULL OR OLD.current_attempt_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE run_id = OLD.id AND call_may_have_started);
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = OLD.owner_id FOR UPDATE;
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1,
      consumed_runs = consumed_runs + CASE WHEN uncertain THEN 1 ELSE 0 END
    WHERE owner_id = OLD.owner_id AND day = OLD.admission_day;
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION app.settle_deleted_ai_budget() OWNER TO app_migrator;
REVOKE ALL ON FUNCTION app.settle_deleted_ai_budget() FROM PUBLIC;
CREATE TRIGGER ai_run_delete_budget BEFORE DELETE ON app.ai_run
FOR EACH ROW EXECUTE FUNCTION app.settle_deleted_ai_budget();
