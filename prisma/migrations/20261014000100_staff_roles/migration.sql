-- Staff roles (2026-10-14). Platform roles ADMIN and MODERATOR, an account audit log, and SECURITY DEFINER functions through which
-- staff change account limits and roles. The web role gets no table grants on the new tables and no write grant on
-- pilot_entitlement; the functions check the actor's role in the same transaction as the change.
--
-- Refusals use dedicated SQLSTATEs the app maps (message in parentheses):
--   SR001 (STAFF_REQUIRED)    the actor has no active staff role; the app answers NOT_FOUND so staff screens do not leak.
--   SR002 (ADMIN_REQUIRED)    a Moderator tried to change a role; the app shows "only Admins can change roles".
--   SR003 (VERSION_CONFLICT)  the expected version is not the current one (0 when there is no row).
--   SR004 (LAST_ADMIN)        the change would leave no active Admin.
--   SR005 (TARGET_NOT_FOUND)  the target profile does not exist.
--   22023                     invalid input: negative limit, unknown role, missing reason, nothing to change.

CREATE TABLE app.platform_role (
  profile_id uuid PRIMARY KEY REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('ADMIN', 'MODERATOR')),
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE app.account_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  target_profile_id uuid NOT NULL,
  action text NOT NULL CHECK (action ~ '^[A-Z_]{1,64}$'),
  before jsonb,
  after jsonb,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_audit_event_target_created ON app.account_audit_event (target_profile_id, created_at DESC);

-- The entitlement version lives apart from the override row so a reset (which deletes the row) never restarts it: it only grows,
-- one step per successful staff change, and no row means version 0.
CREATE TABLE app.account_entitlement_version (
  profile_id uuid PRIMARY KEY REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1)
);

ALTER TABLE app.platform_role OWNER TO app_migrator;
ALTER TABLE app.account_audit_event OWNER TO app_migrator;
ALTER TABLE app.account_entitlement_version OWNER TO app_migrator;
ALTER TABLE app.platform_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_entitlement_version ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.platform_role, app.account_audit_event, app.account_entitlement_version FROM PUBLIC;

CREATE FUNCTION app.staff_role(p_profile uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT role FROM app.platform_role WHERE profile_id = p_profile AND revoked_at IS NULL;
$$;

CREATE FUNCTION app.admin_set_entitlement(
  p_actor uuid, p_target uuid, p_max_owned integer, p_ai_total integer, p_ai_daily integer, p_expires_at timestamptz,
  p_blocked boolean, p_reset boolean, p_reason text, p_expected_version integer, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reason text := btrim(p_reason);
  v_current app.pilot_entitlement%ROWTYPE;
  v_row app.pilot_entitlement%ROWTYPE;
  v_version integer;
  v_has_override boolean;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF app.staff_role(p_actor) IS NULL THEN RAISE EXCEPTION 'STAFF_REQUIRED' USING ERRCODE = 'SR001'; END IF;
  IF p_blocked IS NULL OR p_reset IS NULL OR p_expected_version IS NULL OR p_request_id IS NULL
    OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason of 1 to 500 characters, the version and a request id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_reset AND (p_max_owned IS NULL OR p_max_owned < 0 OR p_ai_total < 0 OR p_ai_daily < 0) THEN
    RAISE EXCEPTION 'limits must be non-negative (AI limits may be null for unlimited)' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.user_profile WHERE id = p_target;
  IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_NOT_FOUND' USING ERRCODE = 'SR005'; END IF;

  -- The lock project creation and AI admission take: a limit change is serialised with both.
  PERFORM app.lock_pilot_entitlement(p_target);
  SELECT * INTO v_current FROM app.pilot_entitlement WHERE profile_id = p_target;
  v_has_override := FOUND;
  v_version := coalesce((SELECT version FROM app.account_entitlement_version WHERE profile_id = p_target), 0);
  IF v_version <> p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'SR003'; END IF;
  IF v_has_override THEN
    v_before := jsonb_build_object('maxOwnedProjects', v_current.max_owned_projects, 'aiTotalRunLimit', v_current.ai_total_run_limit,
      'aiDailyRunLimit', v_current.ai_daily_run_limit, 'expiresAt', v_current.expires_at,
      'blocked', NOT v_current.active OR v_current.revoked_at IS NOT NULL, 'version', v_version);
  END IF;

  IF p_reset THEN
    IF NOT v_has_override THEN RAISE EXCEPTION 'there is no override to reset' USING ERRCODE = '22023'; END IF;
    DELETE FROM app.pilot_entitlement WHERE profile_id = p_target;
  ELSE
    INSERT INTO app.pilot_entitlement AS entitlement (profile_id, max_owned_projects, ai_total_run_limit, ai_daily_run_limit, expires_at, active, revoked_at, granted_by_operator)
    VALUES (p_target, p_max_owned, p_ai_total, p_ai_daily, p_expires_at, NOT p_blocked, CASE WHEN p_blocked THEN clock_timestamp() END, p_actor)
    ON CONFLICT (profile_id) DO UPDATE SET
      max_owned_projects = excluded.max_owned_projects, ai_total_run_limit = excluded.ai_total_run_limit, ai_daily_run_limit = excluded.ai_daily_run_limit,
      expires_at = excluded.expires_at, active = excluded.active, revoked_at = excluded.revoked_at, granted_by_operator = excluded.granted_by_operator
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO app.account_entitlement_version AS account_version (profile_id, version) VALUES (p_target, 1)
  ON CONFLICT (profile_id) DO UPDATE SET version = account_version.version + 1
  RETURNING version INTO v_version;
  IF NOT p_reset THEN
    v_after := jsonb_build_object('maxOwnedProjects', v_row.max_owned_projects, 'aiTotalRunLimit', v_row.ai_total_run_limit,
      'aiDailyRunLimit', v_row.ai_daily_run_limit, 'expiresAt', v_row.expires_at,
      'blocked', NOT v_row.active OR v_row.revoked_at IS NOT NULL, 'version', v_version);
  END IF;

  INSERT INTO app.account_audit_event (actor_id, target_profile_id, action, before, after, reason, request_id)
  VALUES (p_actor, p_target, CASE WHEN p_reset THEN 'ENTITLEMENT_RESET' ELSE 'ENTITLEMENT_SET' END, v_before, v_after, v_reason, p_request_id);
  RETURN jsonb_build_object('profileId', p_target, 'version', v_version, 'override', v_after);
END;
$$;

CREATE FUNCTION app.admin_set_role(
  p_actor uuid, p_target uuid, p_role text, p_reason text, p_expected_version integer, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reason text := btrim(p_reason);
  v_actor_role text := app.staff_role(p_actor);
  v_current app.platform_role%ROWTYPE;
  v_version integer;
  v_active_role text;
  v_row app.platform_role%ROWTYPE;
BEGIN
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'STAFF_REQUIRED' USING ERRCODE = 'SR001'; END IF;
  IF v_actor_role <> 'ADMIN' THEN RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = 'SR002'; END IF;
  IF (p_role IS NOT NULL AND p_role NOT IN ('ADMIN', 'MODERATOR')) OR p_expected_version IS NULL OR p_request_id IS NULL
    OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a role of ADMIN, MODERATOR or null, a reason of 1 to 500 characters, the version and a request id are required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.user_profile WHERE id = p_target;
  IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_NOT_FOUND' USING ERRCODE = 'SR005'; END IF;

  -- One role change at a time (also covers a target with no row yet), and every active Admin row is locked so two concurrent
  -- revocations cannot both see another Admin remaining. The actor is checked again once the locks are held.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.platform_role', 0));
  PERFORM 1 FROM app.platform_role WHERE role = 'ADMIN' AND revoked_at IS NULL ORDER BY profile_id FOR UPDATE;
  IF app.staff_role(p_actor) IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = 'SR002'; END IF;

  SELECT * INTO v_current FROM app.platform_role WHERE profile_id = p_target FOR UPDATE;
  v_version := CASE WHEN FOUND THEN v_current.version ELSE 0 END;
  IF v_version <> p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'SR003'; END IF;
  v_active_role := CASE WHEN v_version > 0 AND v_current.revoked_at IS NULL THEN v_current.role END;
  IF p_role IS NOT DISTINCT FROM v_active_role THEN RAISE EXCEPTION 'the account already has this role state' USING ERRCODE = '22023'; END IF;
  IF v_active_role = 'ADMIN' AND p_role IS DISTINCT FROM 'ADMIN'
    AND (SELECT count(*) FROM app.platform_role WHERE role = 'ADMIN' AND revoked_at IS NULL) = 1 THEN
    RAISE EXCEPTION 'LAST_ADMIN' USING ERRCODE = 'SR004';
  END IF;

  IF p_role IS NULL THEN
    UPDATE app.platform_role SET revoked_at = clock_timestamp(), version = version + 1 WHERE profile_id = p_target RETURNING * INTO v_row;
  ELSE
    INSERT INTO app.platform_role AS platform_role (profile_id, role, granted_by) VALUES (p_target, p_role, p_actor)
    ON CONFLICT (profile_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = clock_timestamp(),
      revoked_at = NULL, version = platform_role.version + 1
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO app.account_audit_event (actor_id, target_profile_id, action, before, after, reason, request_id)
  VALUES (p_actor, p_target, CASE WHEN p_role IS NULL THEN 'ROLE_REVOKED' ELSE 'ROLE_SET' END,
    jsonb_build_object('role', v_active_role), jsonb_build_object('role', p_role), v_reason, p_request_id);
  RETURN jsonb_build_object('profileId', p_target, 'role', p_role, 'version', v_row.version);
END;
$$;

-- Staff reads (Task 2). The web runtime cannot read the new tables, so the list and detail screens read through functions that
-- check the actor's role first. app.account_summary is the one place an account row is assembled; only the two staff functions call it.
-- There are no email addresses here by design: the web runtime has no access to auth.users.
CREATE FUNCTION app.account_summary(p_profile uuid) RETURNS TABLE (
  profile_id uuid, display_name text, staff_role text, plan_kind text,
  override_max_owned integer, override_ai_total integer, override_ai_daily integer, override_expires_at timestamptz,
  active_owned_projects integer, ai_used_total integer, ai_used_today integer, entitlement_version integer, role_version integer,
  last_activity timestamptz
)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT profile.id, profile.display_name, CASE WHEN staff.revoked_at IS NULL THEN staff.role END,
    CASE WHEN override.profile_id IS NULL THEN 'DEFAULT' WHEN NOT override.active OR override.revoked_at IS NOT NULL THEN 'BLOCKED' ELSE 'CUSTOM' END,
    override.max_owned_projects, override.ai_total_run_limit, override.ai_daily_run_limit, override.expires_at,
    (SELECT count(*)::integer FROM app.project WHERE owner_id = profile.id AND status = 'ACTIVE'::app.project_status),
    -- Counted exactly as admission counts: reserved plus consumed, in total and for today's UTC day.
    (SELECT coalesce(sum(reserved_runs + consumed_runs), 0)::integer FROM app.ai_budget_day WHERE owner_id = profile.id),
    (SELECT coalesce(sum(reserved_runs + consumed_runs), 0)::integer FROM app.ai_budget_day
      WHERE owner_id = profile.id AND day = (transaction_timestamp() AT TIME ZONE 'UTC')::date),
    coalesce(entitlement.version, 0), coalesce(staff.version, 0),
    greatest(profile.updated_at, (SELECT max(updated_at) FROM app.project WHERE owner_id = profile.id),
      (SELECT (max(day)::timestamp AT TIME ZONE 'UTC') FROM app.ai_budget_day WHERE owner_id = profile.id))
  FROM app.user_profile profile
  LEFT JOIN app.platform_role staff ON staff.profile_id = profile.id
  LEFT JOIN app.pilot_entitlement override ON override.profile_id = profile.id
  LEFT JOIN app.account_entitlement_version entitlement ON entitlement.profile_id = profile.id
  WHERE profile.id = p_profile;
$$;

CREATE FUNCTION app.admin_list_accounts(p_actor uuid, p_query text, p_after_name text, p_after_id uuid, p_limit integer)
RETURNS TABLE (
  profile_id uuid, display_name text, staff_role text, plan_kind text,
  override_max_owned integer, override_ai_total integer, override_ai_daily integer, override_expires_at timestamptz,
  active_owned_projects integer, ai_used_total integer, ai_used_today integer, entitlement_version integer, role_version integer,
  last_activity timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_query text := btrim(p_query);
BEGIN
  IF app.staff_role(p_actor) IS NULL THEN RAISE EXCEPTION 'STAFF_REQUIRED' USING ERRCODE = 'SR001'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR length(v_query) > 100 OR (p_after_name IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a limit of at least 1, a query of at most 100 characters and a complete cursor are required' USING ERRCODE = '22023';
  END IF;
  -- The page of profiles is chosen first, so the summary (counts and sums) runs only for the rows returned.
  RETURN QUERY
  SELECT summary.* FROM (
    SELECT profile.id, profile.display_name FROM app.user_profile profile
    WHERE (v_query IS NULL OR v_query = '' OR position(lower(v_query) IN lower(profile.display_name)) > 0)
      AND (p_after_name IS NULL OR (profile.display_name, profile.id) > (p_after_name, p_after_id))
    ORDER BY profile.display_name, profile.id
    LIMIT least(p_limit, 50)
  ) page CROSS JOIN LATERAL app.account_summary(page.id) summary
  ORDER BY page.display_name, page.id;
END;
$$;

CREATE FUNCTION app.admin_account_detail(p_actor uuid, p_target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_account jsonb;
BEGIN
  IF app.staff_role(p_actor) IS NULL THEN RAISE EXCEPTION 'STAFF_REQUIRED' USING ERRCODE = 'SR001'; END IF;
  SELECT to_jsonb(summary) INTO v_account FROM app.account_summary(p_target) summary;
  IF v_account IS NULL THEN RAISE EXCEPTION 'TARGET_NOT_FOUND' USING ERRCODE = 'SR005'; END IF;
  RETURN jsonb_build_object('account', v_account, 'audit', coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', audit_row.id, 'actorId', audit_row.actor_id, 'actorName', actor.display_name, 'action', audit_row.action,
      'before', audit_row.before, 'after', audit_row.after, 'reason', audit_row.reason, 'createdAt', audit_row.created_at) ORDER BY audit_row.created_at DESC, audit_row.id DESC)
    FROM (SELECT * FROM app.account_audit_event WHERE target_profile_id = p_target ORDER BY created_at DESC, id DESC LIMIT 50) audit_row
    LEFT JOIN app.user_profile actor ON actor.id = audit_row.actor_id), '[]'::jsonb));
END;
$$;

ALTER FUNCTION app.staff_role(uuid) OWNER TO app_migrator;
ALTER FUNCTION app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid) OWNER TO app_migrator;
ALTER FUNCTION app.admin_set_role(uuid, uuid, text, text, integer, uuid) OWNER TO app_migrator;
ALTER FUNCTION app.account_summary(uuid) OWNER TO app_migrator;
ALTER FUNCTION app.admin_list_accounts(uuid, text, text, uuid, integer) OWNER TO app_migrator;
ALTER FUNCTION app.admin_account_detail(uuid, uuid) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION app.account_summary(uuid), app.admin_list_accounts(uuid, text, text, uuid, integer), app.admin_account_detail(uuid, uuid),
  app.staff_role(uuid), app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid),
  app.admin_set_role(uuid, uuid, text, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_list_accounts(uuid, text, text, uuid, integer), app.admin_account_detail(uuid, uuid),
  app.staff_role(uuid), app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid),
  app.admin_set_role(uuid, uuid, text, text, integer, uuid) TO app_web;
