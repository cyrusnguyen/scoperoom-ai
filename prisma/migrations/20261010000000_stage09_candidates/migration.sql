-- Stage 09a: immutable exact candidates; publication authority arrives in 09b.
CREATE TYPE app.review_state AS ENUM ('OPEN','APPROVED','CHANGES_REQUESTED','REJECTED','WITHDRAWN','SUPERSEDED','STALE');
ALTER TABLE app.project ADD COLUMN reviews_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN baseline_sequence bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT project_review_counters CHECK (reviews_revision BETWEEN 0 AND 9007199254740991 AND baseline_sequence BETWEEN 0 AND 9007199254740991);
ALTER TABLE app.scope_draft ADD COLUMN base_snapshot_id uuid;
CREATE TABLE app.scope_snapshot (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES app.project(id) ON DELETE CASCADE,
  source_draft_id uuid NOT NULL, parent_snapshot_id uuid,
  captured_document_revision integer NOT NULL, captured_layout_revision integer NOT NULL,
  designated_approver_id uuid NOT NULL REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  approval_policy_version integer NOT NULL, payload jsonb NOT NULL,
  content_hash char(64) NOT NULL, review_hash char(64) NOT NULL,
  created_by uuid NOT NULL REFERENCES app.user_profile(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL,
  UNIQUE(project_id,id),
  CONSTRAINT scope_snapshot_versions CHECK (captured_document_revision > 0 AND captured_layout_revision > 0 AND approval_policy_version > 0),
  CONSTRAINT scope_snapshot_hashes CHECK (content_hash ~ '^[0-9a-f]{64}$' AND review_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT scope_snapshot_payload_binding CHECK (COALESCE(
    jsonb_typeof(payload) = 'object'
    AND (payload - ARRAY['canonicalizationVersion','schemaVersion','projectId','projectName','sourceDraftId','capturedDocumentRevision','capturedLayoutRevision','documentJson','layoutJson','evidenceManifest','policySnapshot','parentSnapshotId','agreementIntent','requestResolution']) = '{}'::jsonb
    AND payload ?& ARRAY['canonicalizationVersion','schemaVersion','projectId','projectName','sourceDraftId','capturedDocumentRevision','capturedLayoutRevision','documentJson','layoutJson','evidenceManifest','policySnapshot','parentSnapshotId','agreementIntent','requestResolution']
    AND payload->'canonicalizationVersion' = '1'::jsonb AND payload->'schemaVersion' = '3'::jsonb
    AND payload->>'projectId' = project_id::text AND payload->>'sourceDraftId' = source_draft_id::text
    AND payload->'capturedDocumentRevision' = to_jsonb(captured_document_revision) AND payload->'capturedLayoutRevision' = to_jsonb(captured_layout_revision)
    AND payload->'parentSnapshotId' = COALESCE(to_jsonb(parent_snapshot_id::text),'null'::jsonb)
    AND payload->'policySnapshot' = jsonb_build_object('designatedApproverId',designated_approver_id::text,'approvalPolicyVersion',approval_policy_version)
    AND jsonb_typeof(payload->'projectName')='string' AND char_length(payload->>'projectName') BETWEEN 1 AND 120
    AND jsonb_typeof(payload->'documentJson')='object' AND payload->'documentJson'->'schemaVersion'='3'::jsonb
    AND jsonb_typeof(payload->'layoutJson')='object' AND payload->'layoutJson'->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(payload->'evidenceManifest')='array'
    AND payload->>'agreementIntent'='INCLUDED_SCOPE' AND payload->'requestResolution'='null'::jsonb, false)),
  CONSTRAINT scope_snapshot_source_draft_fkey FOREIGN KEY(project_id,source_draft_id) REFERENCES app.scope_draft(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT scope_snapshot_parent_fkey FOREIGN KEY(project_id,parent_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE app.scope_snapshot ADD CONSTRAINT scope_snapshot_document_size CHECK (octet_length((payload->'documentJson')::text)<=2097152),
  ADD CONSTRAINT scope_snapshot_layout_size CHECK (octet_length((payload->'layoutJson')::text)<=262144),
  ADD CONSTRAINT scope_snapshot_envelope_size CHECK (octet_length((payload || jsonb_build_object('id',id::text,'contentHash',content_hash,'reviewHash',review_hash,'createdBy',created_by::text,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text)<=4194304);
CREATE TABLE app.review_request (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES app.project(id) ON DELETE CASCADE,
  candidate_snapshot_id uuid NOT NULL UNIQUE, source_draft_id uuid NOT NULL, parent_snapshot_id uuid,
  designated_approver_id uuid NOT NULL REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  approval_policy_version integer NOT NULL, state app.review_state NOT NULL DEFAULT 'OPEN', version integer NOT NULL DEFAULT 1,
  last_event_sequence bigint NOT NULL, publication_sequence bigint, published_at timestamptz, closed_reason text,
  created_by uuid NOT NULL REFERENCES app.user_profile(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id,id),
  CONSTRAINT review_request_versions CHECK (version>0 AND approval_policy_version>0 AND last_event_sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT review_request_publication CHECK ((state='APPROVED' AND publication_sequence IS NOT NULL AND publication_sequence BETWEEN 1 AND 9007199254740991 AND published_at IS NOT NULL) OR (state<>'APPROVED' AND publication_sequence IS NULL AND published_at IS NULL)),
  CONSTRAINT review_request_reason CHECK (closed_reason IS NULL OR (char_length(closed_reason) BETWEEN 1 AND 4000 AND closed_reason ~ '[^[:space:]]')),
  CONSTRAINT review_request_candidate_fkey FOREIGN KEY(project_id,candidate_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT review_request_source_draft_fkey FOREIGN KEY(project_id,source_draft_id) REFERENCES app.scope_draft(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT review_request_parent_fkey FOREIGN KEY(project_id,parent_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX review_request_project_id_candidate_snapshot_id_key ON app.review_request(project_id,candidate_snapshot_id);
CREATE UNIQUE INDEX review_request_one_open ON app.review_request(project_id) WHERE state='OPEN';
CREATE UNIQUE INDEX review_request_publication_sequence ON app.review_request(project_id,publication_sequence) WHERE publication_sequence IS NOT NULL;
CREATE INDEX scope_snapshot_project_id_created_at_id_idx ON app.scope_snapshot(project_id,created_at,id);
CREATE INDEX review_request_project_id_created_at_id_idx ON app.review_request(project_id,created_at,id);
ALTER TABLE app.project DROP CONSTRAINT project_baseline_pending_snapshots,
  ADD CONSTRAINT project_approved_snapshot_fkey FOREIGN KEY(id,approved_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX project_id_approved_snapshot_id_key ON app.project(id,approved_snapshot_id);
ALTER TABLE app.scope_draft ADD CONSTRAINT scope_draft_base_snapshot_fkey FOREIGN KEY(project_id,base_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.ai_run DROP CONSTRAINT ai_run_baseline_pending_snapshots,
  ADD CONSTRAINT ai_run_parent_snapshot_fkey FOREIGN KEY(project_id,parent_snapshot_id) REFERENCES app.scope_snapshot(project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION app.reject_snapshot_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN RAISE EXCEPTION 'snapshot is immutable' USING ERRCODE='23514', CONSTRAINT='scope_snapshot_immutable'; END; $$;
CREATE TRIGGER scope_snapshot_immutable BEFORE UPDATE ON app.scope_snapshot FOR EACH ROW EXECUTE FUNCTION app.reject_snapshot_update();
CREATE FUNCTION app.guard_review_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE candidate app.scope_snapshot;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.project_id,NEW.candidate_snapshot_id,NEW.source_draft_id,NEW.parent_snapshot_id,NEW.designated_approver_id,NEW.approval_policy_version,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.candidate_snapshot_id,OLD.source_draft_id,OLD.parent_snapshot_id,OLD.designated_approver_id,OLD.approval_policy_version,OLD.created_by,OLD.created_at) THEN
      RAISE EXCEPTION 'review binding is immutable' USING ERRCODE='23514', CONSTRAINT='review_request_immutable_binding';
    END IF;
    IF NEW.state NOT IN ('WITHDRAWN','SUPERSEDED') OR OLD.state<>'OPEN' OR NEW.version<>OLD.version+1 OR NEW.closed_reason IS NULL OR NEW.last_event_sequence<=OLD.last_event_sequence THEN
      RAISE EXCEPTION 'unsupported review transition' USING ERRCODE='23514', CONSTRAINT='review_request_stage09a_state';
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
CREATE TRIGGER review_request_binding BEFORE INSERT OR UPDATE ON app.review_request FOR EACH ROW EXECUTE FUNCTION app.guard_review_binding();
CREATE CONSTRAINT TRIGGER review_request_candidate_binding_check AFTER INSERT OR UPDATE ON app.review_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_review_binding();
REVOKE ALL ON FUNCTION app.reject_snapshot_update(), app.guard_review_binding() FROM PUBLIC;
GRANT SELECT, INSERT ON app.scope_snapshot, app.review_request TO app_web;
GRANT SELECT ON app.scope_snapshot TO app_worker;
GRANT UPDATE(state,version,closed_reason,last_event_sequence,updated_at) ON app.review_request TO app_web;
GRANT UPDATE(reviews_revision) ON app.project TO app_web;

-- Stage 09a creates projects/drafts, but cannot assign publication or baseline lineage.
-- Table INSERT grants otherwise automatically cover newly introduced authority columns.
REVOKE INSERT ON app.project, app.scope_draft FROM app_web;
GRANT INSERT (id,owner_id,name,status,version,settings_version,approval_policy_version,membership_version,designated_approver_id,current_draft_id,realtime_epoch,event_sequence,ai_revision,sources_revision,requirement_display_sequence,created_at,updated_at) ON app.project TO app_web;
GRANT INSERT (id,project_id,created_by,document_revision,layout_revision,schema_version,document_json,layout_json,status,created_at,updated_at) ON app.scope_draft TO app_web;
