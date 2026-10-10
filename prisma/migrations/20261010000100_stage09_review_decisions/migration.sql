-- Stage 09b: one immutable human decision for each exact frozen review.
CREATE TYPE app.review_decision_kind AS ENUM ('APPROVE','REQUEST_CHANGES','REJECT');
CREATE TABLE app.review_decision (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.project(id) ON DELETE CASCADE,
  review_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  decision app.review_decision_kind NOT NULL,
  comment text,
  reviewed_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(project_id,review_id),
  CONSTRAINT review_decision_review_fkey FOREIGN KEY(project_id,review_id) REFERENCES app.review_request(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT review_decision_hash CHECK (reviewed_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_decision_comment CHECK (
    (comment IS NULL OR char_length(comment) <= 4000)
    AND (decision='APPROVE' OR (comment IS NOT NULL AND btrim(comment, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''))
  )
);
CREATE FUNCTION app.guard_review_decision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE bound_actor uuid; bound_hash char(64); review_state app.review_state;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'review decision is immutable' USING ERRCODE='23514', CONSTRAINT='review_decision_immutable';
  END IF;
  SELECT r.designated_approver_id,s.review_hash,r.state INTO bound_actor,bound_hash,review_state
    FROM app.review_request r JOIN app.scope_snapshot s ON s.project_id=r.project_id AND s.id=r.candidate_snapshot_id
    WHERE r.project_id=NEW.project_id AND r.id=NEW.review_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- the composite FK owns missing/foreign review references
  IF review_state<>'OPEN' OR NEW.actor_id<>bound_actor OR NEW.reviewed_hash<>bound_hash THEN
    RAISE EXCEPTION 'decision binding mismatch' USING ERRCODE='23514', CONSTRAINT='review_decision_binding';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER review_decision_binding BEFORE INSERT OR UPDATE ON app.review_decision FOR EACH ROW EXECUTE FUNCTION app.guard_review_decision();
REVOKE ALL ON FUNCTION app.guard_review_decision() FROM PUBLIC;
GRANT SELECT, INSERT ON app.review_decision TO app_web;
GRANT SELECT ON app.review_decision TO app_worker;
GRANT UPDATE(publication_sequence,published_at) ON app.review_request TO app_web;
GRANT UPDATE(approved_snapshot_id,baseline_sequence) ON app.project TO app_web;
GRANT UPDATE(base_snapshot_id) ON app.scope_draft TO app_web;

-- Extend the existing transition guard while retaining candidate/policy/lineage immutability.
CREATE OR REPLACE FUNCTION app.guard_review_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate app.scope_snapshot;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.project_id,NEW.candidate_snapshot_id,NEW.source_draft_id,NEW.parent_snapshot_id,NEW.designated_approver_id,NEW.approval_policy_version,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.candidate_snapshot_id,OLD.source_draft_id,OLD.parent_snapshot_id,OLD.designated_approver_id,OLD.approval_policy_version,OLD.created_by,OLD.created_at) THEN
      RAISE EXCEPTION 'review binding is immutable' USING ERRCODE='23514', CONSTRAINT='review_request_immutable_binding';
    END IF;
    IF NEW.state NOT IN ('APPROVED','CHANGES_REQUESTED','REJECTED','WITHDRAWN','SUPERSEDED') OR OLD.state<>'OPEN' OR NEW.version<>OLD.version+1 OR (NEW.state<>'APPROVED' AND NEW.closed_reason IS NULL) OR NEW.last_event_sequence<=OLD.last_event_sequence THEN
      RAISE EXCEPTION 'unsupported review transition' USING ERRCODE='23514', CONSTRAINT='review_request_terminal_state';
    END IF;
    IF NEW.state IN ('APPROVED','CHANGES_REQUESTED','REJECTED') AND NOT EXISTS (
      SELECT 1 FROM app.review_decision d WHERE d.project_id=NEW.project_id AND d.review_id=NEW.id
        AND d.decision = CASE NEW.state WHEN 'APPROVED' THEN 'APPROVE'::app.review_decision_kind
          WHEN 'CHANGES_REQUESTED' THEN 'REQUEST_CHANGES'::app.review_decision_kind ELSE 'REJECT'::app.review_decision_kind END
    ) THEN
      RAISE EXCEPTION 'review decision mismatch' USING ERRCODE='23514', CONSTRAINT='review_request_decision_binding';
    END IF;
  ELSE
    IF NEW.state<>'OPEN' OR NEW.version<>1 OR NEW.publication_sequence IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.closed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'new review must be open' USING ERRCODE='23514', CONSTRAINT='review_request_initial_state';
    END IF;
  END IF;
  SELECT * INTO candidate FROM app.scope_snapshot WHERE project_id=NEW.project_id AND id=NEW.candidate_snapshot_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- deferred composite FK owns missing/foreign references
  IF ROW(NEW.source_draft_id,NEW.parent_snapshot_id,NEW.designated_approver_id,NEW.approval_policy_version,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM ROW(candidate.source_draft_id,candidate.parent_snapshot_id,candidate.designated_approver_id,candidate.approval_policy_version,candidate.created_by,candidate.created_at) THEN
    RAISE EXCEPTION 'candidate binding mismatch' USING ERRCODE='23514', CONSTRAINT='review_request_candidate_binding';
  END IF;
  RETURN NEW;
END; $$;

