CREATE FUNCTION "app"."lock_workspace_for_project_read"(target_workspace_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM app.workspace WHERE id = target_workspace_id FOR SHARE;
END;
$$;

ALTER FUNCTION "app"."lock_workspace_for_project_read"(uuid) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION "app"."lock_workspace_for_project_read"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."lock_workspace_for_project_read"(uuid) TO app_web;
