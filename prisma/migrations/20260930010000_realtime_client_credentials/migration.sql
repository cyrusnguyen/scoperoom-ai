-- Stage 04.3 (E36): the helper also authorizes the scoped Realtime credential the server mints for the dedicated app_realtime_client
-- role. That token has no sub: its identity is the server-minted profile_id claim, bound to one project and epoch. Both the claim role
-- and the database role Realtime switched to must be app_realtime_client, and a token carrying sub is refused. Everything after the
-- join (membership, lifecycle, capability) is unchanged. Claims are compared as text, so malformed values deny and never raise.
-- Replacing the function needs its owner: guarded setup (scripts/db/realtime.mjs) lends app_migrator the reader role for this run only.
CREATE OR REPLACE FUNCTION "app_private"."can_realtime"(topic text, capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(EXISTS (
    SELECT 1 FROM app.project p
    JOIN app.user_profile u ON CASE
      WHEN (SELECT auth.jwt())->>'role' = 'app_realtime_client' THEN
        current_setting('role', true) = 'app_realtime_client'
        AND NOT jsonb_exists((SELECT auth.jwt()), 'sub')
        AND u.id::text = (SELECT auth.jwt())->>'profile_id'
        AND p.id::text = (SELECT auth.jwt())->>'project_id'
        AND p.realtime_epoch::text = (SELECT auth.jwt())->>'realtime_epoch'
      ELSE current_setting('role', true) IS DISTINCT FROM 'app_realtime_client'
        AND u.auth_user_id = (SELECT auth.uid())
    END
    LEFT JOIN app.project_membership m
      ON m.project_id = p.id AND m.profile_id = u.id AND m.active
    WHERE p.status IN ('ACTIVE', 'ARCHIVED')
      AND coalesce((SELECT auth.jwt())->>'is_anonymous', 'false') <> 'true'
      AND (p.owner_id = u.id OR m.profile_id IS NOT NULL)
      AND (
        (capability = 'receive_broadcast' AND topic IN (
          'project:' || p.id::text || ':' || p.realtime_epoch::text || ':events',
          'project:' || p.id::text || ':' || p.realtime_epoch::text || ':collab'))
        OR (capability = 'presence' AND topic =
          'project:' || p.id::text || ':' || p.realtime_epoch::text || ':collab')
        OR (capability = 'send_broadcast' AND p.status = 'ACTIVE'
          AND (p.owner_id = u.id OR m.role = 'EDITOR') AND topic =
          'project:' || p.id::text || ':' || p.realtime_epoch::text || ':collab')
      )
  ), false)
$$;
