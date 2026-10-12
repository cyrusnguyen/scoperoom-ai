-- Default account plan (2026-10-12). An account without a pilot_entitlement row is on the default plan the app defines
-- (10 active owned projects, 5 AI requests in total, 30 a day). A row is an operator or admin override: while active and
-- unexpired it replaces those defaults; an inactive or revoked row blocks project ownership and AI; an expired row falls back
-- to the defaults. NULL AI limits are unlimited. Existing rows keep their current behaviour: no total limit and 30 a day.
ALTER TABLE app.pilot_entitlement
  ADD COLUMN ai_total_run_limit integer,
  ADD COLUMN ai_daily_run_limit integer DEFAULT 30,
  ADD CONSTRAINT pilot_entitlement_ai_limits_nonnegative
    CHECK ((ai_total_run_limit IS NULL OR ai_total_run_limit >= 0) AND (ai_daily_run_limit IS NULL OR ai_daily_run_limit >= 0));

-- Daily limits now come from the owner's plan, checked by admission under the owner allowance lock; the counters stay non-negative.
ALTER TABLE app.ai_budget_day DROP CONSTRAINT ai_budget_day_counters;
ALTER TABLE app.ai_budget_day ADD CONSTRAINT ai_budget_day_counters CHECK (reserved_runs >= 0 AND consumed_runs >= 0);

-- Owners on the default plan have no row to lock, so the owner capacity guard also takes a per-owner transaction lock.
CREATE OR REPLACE FUNCTION app.lock_pilot_entitlement(profile_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.owner_capacity:' || lock_pilot_entitlement.profile_id::text, 0));
  PERFORM 1 FROM app.pilot_entitlement WHERE pilot_entitlement.profile_id = lock_pilot_entitlement.profile_id FOR UPDATE;
END;
$$;

-- AI authority: only an inactive or revoked override blocks the owner; no row, or an expired one, is the default plan.
CREATE OR REPLACE FUNCTION app.ai_actor_may_run(p_project_id uuid, p_actor_id uuid) RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.project AS project
    WHERE project.id = p_project_id AND project.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM app.pilot_entitlement AS entitlement
        WHERE entitlement.profile_id = project.owner_id AND (NOT entitlement.active OR entitlement.revoked_at IS NOT NULL))
      AND (project.owner_id = p_actor_id OR EXISTS (
        SELECT 1 FROM app.project_membership AS membership
        WHERE membership.project_id = project.id AND membership.profile_id = p_actor_id AND membership.active AND membership.role = 'EDITOR'))
  );
$$;
