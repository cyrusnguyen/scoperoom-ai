-- Stage 06.1 reads and cancellation: the web role settles only runs whose SQL deadline has passed, through finish_ai_run's own guards
-- (project lock, run lock, allowance, budget day; a reservation that never reached a provider claim is released once, a possibly
-- started call stays consumed). Web gets no claim/settle/finish access and no dispatch column UPDATE.
CREATE FUNCTION "app"."settle_overdue_ai_runs"(p_project_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  overdue record;
  settled integer := 0;
BEGIN
  -- Unlocked probe first, so a read with nothing overdue takes no lock; finish_ai_run revalidates under the locks and is idempotent.
  FOR overdue IN SELECT id FROM app.ai_run WHERE project_id = p_project_id AND state IN ('QUEUED', 'RUNNING', 'VALIDATING') AND deadline_at <= clock_timestamp() ORDER BY id LOOP
    IF app.finish_ai_run(overdue.id, 'TIMED_OUT', NULL) = 'SETTLED' THEN settled := settled + 1; END IF;
  END LOOP;
  RETURN settled;
END;
$$;

ALTER FUNCTION "app"."settle_overdue_ai_runs"(uuid) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."settle_overdue_ai_runs"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."settle_overdue_ai_runs"(uuid) TO app_web;
