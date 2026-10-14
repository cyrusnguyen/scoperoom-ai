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

-- Existing override rows start at version 1; a missing row is version 0.
ALTER TABLE app.pilot_entitlement ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE app.platform_role OWNER TO app_migrator;
ALTER TABLE app.account_audit_event OWNER TO app_migrator;
ALTER TABLE app.platform_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_audit_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.platform_role, app.account_audit_event FROM PUBLIC;

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
  v_version := CASE WHEN FOUND THEN v_current.version ELSE 0 END;
  IF v_version <> p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'SR003'; END IF;
  IF v_version > 0 THEN
    v_before := jsonb_build_object('maxOwnedProjects', v_current.max_owned_projects, 'aiTotalRunLimit', v_current.ai_total_run_limit,
      'aiDailyRunLimit', v_current.ai_daily_run_limit, 'expiresAt', v_current.expires_at,
      'blocked', NOT v_current.active OR v_current.revoked_at IS NOT NULL, 'version', v_current.version);
  END IF;

  IF p_reset THEN
    IF v_version = 0 THEN RAISE EXCEPTION 'there is no override to reset' USING ERRCODE = '22023'; END IF;
    DELETE FROM app.pilot_entitlement WHERE profile_id = p_target;
  ELSE
    INSERT INTO app.pilot_entitlement AS entitlement (profile_id, max_owned_projects, ai_total_run_limit, ai_daily_run_limit, expires_at, active, revoked_at, granted_by_operator)
    VALUES (p_target, p_max_owned, p_ai_total, p_ai_daily, p_expires_at, NOT p_blocked, CASE WHEN p_blocked THEN clock_timestamp() END, p_actor)
    ON CONFLICT (profile_id) DO UPDATE SET
      max_owned_projects = excluded.max_owned_projects, ai_total_run_limit = excluded.ai_total_run_limit, ai_daily_run_limit = excluded.ai_daily_run_limit,
      expires_at = excluded.expires_at, active = excluded.active, revoked_at = excluded.revoked_at, granted_by_operator = excluded.granted_by_operator,
      version = entitlement.version + 1
    RETURNING * INTO v_row;
    v_after := jsonb_build_object('maxOwnedProjects', v_row.max_owned_projects, 'aiTotalRunLimit', v_row.ai_total_run_limit,
      'aiDailyRunLimit', v_row.ai_daily_run_limit, 'expiresAt', v_row.expires_at,
      'blocked', NOT v_row.active OR v_row.revoked_at IS NOT NULL, 'version', v_row.version);
  END IF;

  INSERT INTO app.account_audit_event (actor_id, target_profile_id, action, before, after, reason, request_id)
  VALUES (p_actor, p_target, CASE WHEN p_reset THEN 'ENTITLEMENT_RESET' ELSE 'ENTITLEMENT_SET' END, v_before, v_after, v_reason, p_request_id);
  RETURN jsonb_build_object('profileId', p_target, 'version', CASE WHEN p_reset THEN 0 ELSE v_row.version END, 'override', v_after);
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

ALTER FUNCTION app.staff_role(uuid) OWNER TO app_migrator;
ALTER FUNCTION app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid) OWNER TO app_migrator;
ALTER FUNCTION app.admin_set_role(uuid, uuid, text, text, integer, uuid) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION app.staff_role(uuid), app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid),
  app.admin_set_role(uuid, uuid, text, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_role(uuid), app.admin_set_entitlement(uuid, uuid, integer, integer, integer, timestamptz, boolean, boolean, text, integer, uuid),
  app.admin_set_role(uuid, uuid, text, text, integer, uuid) TO app_web;
