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

-- Committed change hints. A narrow adapter over the provider's realtime.send and a trigger function that reports every effective
-- event_sequence advance. Guarded setup transfers both to app_realtime_notifier (schema USAGE, realtime.send and a topic-restricted
-- insert policy only) and verifies them. Nobody else can execute them; the trigger fires under any role that updates app.project.
CREATE FUNCTION "app_private"."enqueue_project_hint"(payload jsonb, topic text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM realtime.send(payload, 'PROJECT_CHANGED', topic, true);
END;
$$;
REVOKE ALL ON FUNCTION "app_private"."enqueue_project_hint"(jsonb, text) FROM PUBLIC;

-- Only the hint is guarded: a delivery failure raises a warning and never rolls back the save. The provider's own send already turns
-- its insert failures into a WarnSendingBroadcastMessage warning; this guard also covers the adapter and its grants.
CREATE FUNCTION "app_private"."notify_project_changed"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    PERFORM app_private.enqueue_project_hint(
      jsonb_build_object('type', 'PROJECT_CHANGED', 'projectId', NEW.id::text,
        'epoch', NEW.realtime_epoch::text, 'eventSequence', NEW.event_sequence),
      'project:' || NEW.id::text || ':' || NEW.realtime_epoch::text || ':events');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'SCOPEROOM_REALTIME_ENQUEUE_FAILED project=% sequence=% sqlstate=%',
      NEW.id, NEW.event_sequence, SQLSTATE;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "app_private"."notify_project_changed"() FROM PUBLIC;

CREATE TRIGGER "project_changed_hint" AFTER UPDATE OF "event_sequence" ON "app"."project"
FOR EACH ROW WHEN (NEW."event_sequence" > OLD."event_sequence")
EXECUTE FUNCTION "app_private"."notify_project_changed"();
