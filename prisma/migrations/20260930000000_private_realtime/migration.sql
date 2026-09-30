-- Stage 04.1: private Realtime authorization helper. Guarded setup (scripts/db/realtime.mjs) creates the schema and
-- restricted roles before this runs, then transfers this function to app_realtime_reader, verifies it and only
-- then grants browser access and installs the provider policies. Until then browsers cannot execute it.
REVOKE ALL ON SCHEMA "app_private" FROM PUBLIC;

CREATE FUNCTION "app_private"."can_realtime"(topic text, capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(EXISTS (
    SELECT 1 FROM app.project p
    JOIN app.user_profile u ON u.auth_user_id = (SELECT auth.uid())
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
REVOKE ALL ON FUNCTION "app_private"."can_realtime"(text, text) FROM PUBLIC;
