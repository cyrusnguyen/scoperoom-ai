-- Flow-filtered history outlives the full capture body. A flow is a JSON graph entity that can be deleted;
-- retain its originating identity without a foreign key to the live graph.
ALTER TABLE "app"."ai_run" ADD COLUMN "flow_id" uuid;

-- Backfill only directly proved identity. Start receipts retain a manifest without selection/flowId;
-- already purged captures cannot be reconstructed from a current draft or guessed from result edits.
UPDATE "app"."ai_run"
SET "flow_id" = ("capture" #>> '{selection,flowId}')::uuid
WHERE "task_type" = 'REFINE_FLOW_SELECTION'
  AND "capture" #>> '{selection,flowId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Keep the existing lifecycle guard (including validation recovery fencing) unchanged.
-- Deriving the column at INSERT also covers callers that omit it, and no role gains an UPDATE grant.
CREATE FUNCTION "app"."enforce_ai_run_flow"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  captured_flow text;
  originating_flow uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.flow_id IS DISTINCT FROM OLD.flow_id THEN
      RAISE EXCEPTION 'AI run flow identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.task_type = 'REFINE_FLOW_SELECTION' THEN
    captured_flow := NEW.capture #>> '{selection,flowId}';
    IF captured_flow IS NULL OR captured_flow !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'AI run capture flow identity is invalid' USING ERRCODE = '23514';
    END IF;
    originating_flow := captured_flow::uuid;
  END IF;
  IF NEW.flow_id IS NOT NULL AND NEW.flow_id IS DISTINCT FROM originating_flow THEN
    RAISE EXCEPTION 'AI run capture flow identity mismatch' USING ERRCODE = '23514';
  END IF;
  NEW.flow_id := originating_flow;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "enforce_ai_run_flow" BEFORE INSERT OR UPDATE ON "app"."ai_run"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_ai_run_flow"();
ALTER FUNCTION "app"."enforce_ai_run_flow"() OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."enforce_ai_run_flow"() FROM PUBLIC;
-- Existing table-level SELECT/INSERT grants include flow_id. Column-specific UPDATE grants do not.
