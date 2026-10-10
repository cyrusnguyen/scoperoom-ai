-- Recheck deferred review references so insert order cannot bypass frozen attribution.
CREATE OR REPLACE FUNCTION app.guard_review_decision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE bound_actor uuid; bound_hash char(64); review_state app.review_state;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'review decision is immutable' USING ERRCODE='23514', CONSTRAINT='review_decision_immutable';
  END IF;
  SELECT r.designated_approver_id,s.review_hash,r.state INTO bound_actor,bound_hash,review_state
    FROM app.review_request r JOIN app.scope_snapshot s ON s.project_id=r.project_id AND s.id=r.candidate_snapshot_id
    WHERE r.project_id=NEW.project_id AND r.id=NEW.review_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- the composite FK owns missing/foreign review references
  IF (TG_WHEN='BEFORE' AND review_state<>'OPEN') OR NEW.actor_id<>bound_actor OR NEW.reviewed_hash<>bound_hash THEN
    RAISE EXCEPTION 'decision binding mismatch' USING ERRCODE='23514', CONSTRAINT='review_decision_binding';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER review_decision_binding_check AFTER INSERT ON app.review_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_review_decision();
