-- Fix: the batch lease function took a NULL run id, so web could lease the whole cross-tenant backlog. Web now gets only a
-- single-run wrapper (NULL leases nothing); the batch form stays with the worker, which owns repair.
CREATE FUNCTION "app"."lease_ai_dispatch"(p_run_id uuid, p_lease_seconds integer)
RETURNS TABLE ("out_run_id" uuid, "out_dispatch_id" uuid, "out_execution_binding" text, "out_deadline_at" timestamptz, "out_lease" text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT leased.out_run_id, leased.out_dispatch_id, leased.out_execution_binding, leased.out_deadline_at, leased.out_lease
  FROM app.lease_ai_dispatches(p_run_id, 1, p_lease_seconds) AS leased WHERE p_run_id IS NOT NULL;
$$;

ALTER FUNCTION "app"."lease_ai_dispatch"(uuid, integer) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."lease_ai_dispatch"(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "app"."lease_ai_dispatches"(uuid, integer, integer) FROM app_web;
GRANT EXECUTE ON FUNCTION "app"."lease_ai_dispatch"(uuid, integer) TO app_web, app_worker;
