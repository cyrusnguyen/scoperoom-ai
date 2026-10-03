-- Stage 06.1: immutable source evidence, durable AI runs/attempts and the logical owner/day allowance (Data 01, Data 04).
-- Web admits and cancels; the worker claims calls and settles only through the SECURITY DEFINER functions below, so it never
-- holds a draft, membership, entitlement or approval write. Later Stage 06 tasks add their own migrations.
CREATE TYPE "app"."source_kind" AS ENUM ('USER_TEXT', 'USER_UPLOAD', 'QUESTION_ANSWER', 'AI_PROMPT', 'PROMOTED_GRAPH');
CREATE TYPE "app"."ai_task_kind" AS ENUM ('PROPOSE_FLOW', 'REFINE_FLOW_SELECTION');
CREATE TYPE "app"."ai_run_state" AS ENUM ('QUEUED', 'RUNNING', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "app"."ai_result_disposition" AS ENUM ('AVAILABLE', 'APPLIED', 'DISCARDED', 'EXPIRED');
CREATE TYPE "app"."ai_dispatch_state" AS ENUM ('PENDING', 'DISPATCHED');
CREATE TYPE "app"."ai_budget_state" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');
CREATE TYPE "app"."ai_attempt_outcome" AS ENUM ('COMPLETED', 'REFUSED', 'INCOMPLETE', 'UNAVAILABLE', 'UNKNOWN', 'TIMED_OUT', 'CANCELLED');

-- The baseline identity capture needs. No snapshot table exists before Stage 09, so the pointer is null until it adds its FK.
ALTER TABLE "app"."project"
  ADD COLUMN "ai_revision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "approved_snapshot_id" UUID,
  ADD CONSTRAINT "project_ai_revision_safe_integer" CHECK ("ai_revision" BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT "project_baseline_pending_snapshots" CHECK ("approved_snapshot_id" IS NULL);

CREATE TABLE "app"."source_document" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "kind" "app"."source_kind" NOT NULL,
  "current_version_id" UUID,
  "display_nickname" TEXT,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "last_event_sequence" BIGINT NOT NULL DEFAULT 0,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_document_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_document_project_id_id_key" UNIQUE ("project_id", "id"),
  CONSTRAINT "source_document_nickname_length" CHECK ("display_nickname" IS NULL OR char_length("display_nickname") BETWEEN 1 AND 120),
  CONSTRAINT "source_document_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "source_document_event_sequence_safe_integer" CHECK ("last_event_sequence" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "source_document_project_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "source_document_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "app"."source_version" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "code_point_count" INTEGER NOT NULL,
  "utf8_byte_count" INTEGER NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "origin" JSONB,
  CONSTRAINT "source_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_version_source_sequence_key" UNIQUE ("source_id", "sequence"),
  CONSTRAINT "source_version_project_source_id_key" UNIQUE ("project_id", "source_id", "id"),
  CONSTRAINT "source_version_project_id_key" UNIQUE ("project_id", "id"),
  CONSTRAINT "source_version_sequence_positive" CHECK ("sequence" >= 1),
  CONSTRAINT "source_version_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
  CONSTRAINT "source_version_text_length" CHECK ("code_point_count" = char_length("text") AND "code_point_count" BETWEEN 1 AND 50000),
  CONSTRAINT "source_version_text_bytes" CHECK ("utf8_byte_count" = octet_length("text")),
  CONSTRAINT "source_version_content_hash" CHECK ("content_hash" = encode(sha256(convert_to("text", 'UTF8')), 'hex')),
  CONSTRAINT "source_version_normalized" CHECK (position(chr(13) in "text") = 0 AND left("text", 1) <> chr(65279)),
  CONSTRAINT "source_version_origin_size" CHECK ("origin" IS NULL OR (jsonb_typeof("origin") = 'object' AND octet_length("origin"::text) <= 4096)),
  CONSTRAINT "source_version_source_fkey" FOREIGN KEY ("project_id", "source_id") REFERENCES "app"."source_document"("project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "source_version_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

ALTER TABLE "app"."source_document" ADD CONSTRAINT "source_document_current_version_fkey"
  FOREIGN KEY ("project_id", "id", "current_version_id") REFERENCES "app"."source_version"("project_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Charged-owner serialization row and the owner/UTC-day logical counters. Models and configuration never partition or reset a day.
CREATE TABLE "app"."ai_owner_allowance" (
  "owner_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_owner_allowance_pkey" PRIMARY KEY ("owner_id"),
  CONSTRAINT "ai_owner_allowance_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "app"."ai_budget_day" (
  "owner_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "reserved_runs" INTEGER NOT NULL DEFAULT 0,
  "consumed_runs" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ai_budget_day_pkey" PRIMARY KEY ("owner_id", "day"),
  CONSTRAINT "ai_budget_day_counters" CHECK ("reserved_runs" >= 0 AND "consumed_runs" >= 0 AND "reserved_runs" + "consumed_runs" <= 30),
  CONSTRAINT "ai_budget_day_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."ai_owner_allowance"("owner_id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "app"."ai_run" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "draft_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "admission_day" DATE NOT NULL,
  "prompt_source_version_id" UUID NOT NULL,
  "task_type" "app"."ai_task_kind" NOT NULL,
  "model" TEXT NOT NULL,
  "execution_binding" TEXT NOT NULL,
  "capture" JSONB,
  "capture_hash" CHAR(64) NOT NULL,
  "expected_document_revision" INTEGER NOT NULL,
  "parent_snapshot_id" UUID,
  "state" "app"."ai_run_state" NOT NULL DEFAULT 'QUEUED',
  "disposition" "app"."ai_result_disposition",
  "result" JSONB,
  "result_hash" CHAR(64),
  "diff" JSONB,
  "failure_code" TEXT,
  "deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "dispatch_state" "app"."ai_dispatch_state" NOT NULL DEFAULT 'PENDING',
  "dispatch_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_id" TEXT,
  "dispatch_lease_until" TIMESTAMPTZ(6),
  "next_dispatch_at" TIMESTAMPTZ(6),
  "current_attempt_id" UUID,
  "budget_state" "app"."ai_budget_state" NOT NULL DEFAULT 'RESERVED',
  "cancel_requested_at" TIMESTAMPTZ(6),
  "terminal_at" TIMESTAMPTZ(6),
  "last_event_sequence" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_project_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."project"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_project_draft_fkey" FOREIGN KEY ("project_id", "draft_id") REFERENCES "app"."scope_draft"("project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."user_profile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_owner_allowance_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."ai_owner_allowance"("owner_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_budget_day_fkey" FOREIGN KEY ("owner_id", "admission_day") REFERENCES "app"."ai_budget_day"("owner_id", "day") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_prompt_version_fkey" FOREIGN KEY ("project_id", "prompt_source_version_id") REFERENCES "app"."source_version"("project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ai_run_utc_day" CHECK ("admission_day" = ("created_at" AT TIME ZONE 'UTC')::date),
  CONSTRAINT "ai_run_model_length" CHECK (char_length("model") BETWEEN 1 AND 200 AND char_length("execution_binding") BETWEEN 1 AND 200),
  CONSTRAINT "ai_run_revision_positive" CHECK ("expected_document_revision" > 0),
  CONSTRAINT "ai_run_baseline_pending_snapshots" CHECK ("parent_snapshot_id" IS NULL),
  CONSTRAINT "ai_run_hashes" CHECK ("capture_hash" ~ '^[0-9a-f]{64}$' AND ("result_hash" IS NULL OR "result_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "ai_run_capture_size" CHECK ("capture" IS NULL OR octet_length("capture"::text) <= 262144),
  CONSTRAINT "ai_run_result_size" CHECK ("result" IS NULL OR octet_length("result"::text) <= 262144),
  CONSTRAINT "ai_run_diff_size" CHECK ("diff" IS NULL OR octet_length("diff"::text) <= 262144),
  CONSTRAINT "ai_run_deadline" CHECK ("deadline_at" > "created_at" AND "deadline_at" <= "created_at" + INTERVAL '300 seconds'),
  CONSTRAINT "ai_run_terminal_at" CHECK (("state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')) = ("terminal_at" IS NOT NULL)),
  CONSTRAINT "ai_run_result_identity" CHECK (("state" = 'SUCCEEDED') = ("result_hash" IS NOT NULL) AND ("state" = 'SUCCEEDED') = ("disposition" IS NOT NULL)),
  CONSTRAINT "ai_run_result_state" CHECK (("result" IS NULL AND "diff" IS NULL) OR "state" = 'SUCCEEDED'),
  CONSTRAINT "ai_run_capture_retention" CHECK ("capture" IS NOT NULL OR "terminal_at" IS NOT NULL),
  CONSTRAINT "ai_run_failure_code" CHECK (("failure_code" IS NULL OR "failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$') AND ("state" <> 'FAILED' OR "failure_code" IS NOT NULL)),
  CONSTRAINT "ai_run_dispatch" CHECK (("dispatch_state" = 'DISPATCHED') = ("task_id" IS NOT NULL) AND ("task_id" IS NULL OR char_length("task_id") BETWEEN 1 AND 200)),
  CONSTRAINT "ai_run_budget_release" CHECK ("budget_state" <> 'RELEASED' OR "terminal_at" IS NOT NULL),
  CONSTRAINT "ai_run_event_sequence_safe_integer" CHECK ("last_event_sequence" BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE "app"."ai_run_attempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "token" UUID NOT NULL DEFAULT gen_random_uuid(),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "call_may_have_started" BOOLEAN NOT NULL DEFAULT false,
  "outcome" "app"."ai_attempt_outcome",
  "settled_at" TIMESTAMPTZ(6),
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "provider_request_id" TEXT,
  CONSTRAINT "ai_run_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_attempt_run_number_key" UNIQUE ("run_id", "attempt_number"),
  CONSTRAINT "ai_run_attempt_run_id_key" UNIQUE ("run_id", "id"),
  CONSTRAINT "ai_run_attempt_token_key" UNIQUE ("token"),
  CONSTRAINT "ai_run_attempt_number" CHECK ("attempt_number" BETWEEN 1 AND 2),
  CONSTRAINT "ai_run_attempt_window" CHECK ("deadline_at" > "started_at" AND "deadline_at" <= "started_at" + INTERVAL '120 seconds'),
  CONSTRAINT "ai_run_attempt_settled" CHECK (("outcome" IS NULL) = ("settled_at" IS NULL)),
  CONSTRAINT "ai_run_attempt_usage" CHECK (("input_tokens" IS NULL OR "input_tokens" BETWEEN 0 AND 9007199254740991) AND ("output_tokens" IS NULL OR "output_tokens" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ai_run_attempt_request_id" CHECK ("provider_request_id" IS NULL OR char_length("provider_request_id") BETWEEN 1 AND 200),
  CONSTRAINT "ai_run_attempt_run_fkey" FOREIGN KEY ("run_id") REFERENCES "app"."ai_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- The run's only settling attempt must belong to the same run.
ALTER TABLE "app"."ai_run" ADD CONSTRAINT "ai_run_current_attempt_fkey"
  FOREIGN KEY ("id", "current_attempt_id") REFERENCES "app"."ai_run_attempt"("run_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "ai_one_nonterminal_project" ON "app"."ai_run"("project_id") WHERE "state" IN ('QUEUED', 'RUNNING', 'VALIDATING');
CREATE INDEX "ai_run_owner_nonterminal_idx" ON "app"."ai_run"("owner_id") WHERE "state" IN ('QUEUED', 'RUNNING', 'VALIDATING');
CREATE INDEX "ai_run_project_history_idx" ON "app"."ai_run"("project_id", "created_at" DESC, "id" DESC);
CREATE INDEX "ai_run_deadline_idx" ON "app"."ai_run"("deadline_at", "id") WHERE "state" IN ('QUEUED', 'RUNNING', 'VALIDATING');
CREATE INDEX "ai_run_dispatch_due_idx" ON "app"."ai_run"("next_dispatch_at", "id") WHERE "dispatch_state" = 'PENDING' AND "state" = 'QUEUED';
CREATE INDEX "ai_run_body_expiry_idx" ON "app"."ai_run"("terminal_at", "id") WHERE "capture" IS NOT NULL OR "result" IS NOT NULL;
CREATE INDEX "ai_run_actor_idx" ON "app"."ai_run"("actor_id");
CREATE INDEX "ai_run_prompt_version_idx" ON "app"."ai_run"("project_id", "prompt_source_version_id");

-- Source evidence is write-once; a source must be committed with its valid head (deferred, like the project's current draft).
CREATE FUNCTION "app"."reject_source_version_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'source versions are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION "app"."enforce_source_document"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'source document identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app"."enforce_source_head"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.source_document AS source WHERE source.id = NEW.id AND source.current_version_id IS NULL) THEN
    RAISE EXCEPTION 'a source document requires its current version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "source_version_immutable" BEFORE UPDATE ON "app"."source_version"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_source_version_update"();
CREATE TRIGGER "source_document_identity" BEFORE UPDATE ON "app"."source_document"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_source_document"();
CREATE CONSTRAINT TRIGGER "source_document_valid_head" AFTER INSERT OR UPDATE OF "current_version_id" ON "app"."source_document"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app"."enforce_source_head"();

-- A run is admitted only in its initial state, charged to the project's owner, with its prompt evidence and capture agreeing.
CREATE FUNCTION "app"."enforce_ai_run_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.state <> 'QUEUED' OR NEW.disposition IS NOT NULL OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL OR NEW.diff IS NOT NULL
    OR NEW.failure_code IS NOT NULL OR NEW.dispatch_state <> 'PENDING' OR NEW.task_id IS NOT NULL OR NEW.dispatch_lease_until IS NOT NULL
    OR NEW.current_attempt_id IS NOT NULL OR NEW.budget_state <> 'RESERVED' OR NEW.cancel_requested_at IS NOT NULL OR NEW.terminal_at IS NOT NULL
    OR NEW.capture IS NULL OR jsonb_typeof(NEW.capture) <> 'object' THEN
    RAISE EXCEPTION 'an AI run starts queued with no result' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.project AS project WHERE project.id = NEW.project_id AND project.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'an AI run is charged to its project owner' USING ERRCODE = '23514';
  END IF;
  IF NEW.capture->>'taskType' IS DISTINCT FROM NEW.task_type::text OR NEW.capture->>'draftId' IS DISTINCT FROM NEW.draft_id::text
    OR NEW.capture->>'documentRevision' IS DISTINCT FROM NEW.expected_document_revision::text OR NEW.capture->'parentSnapshotId' IS DISTINCT FROM 'null'::jsonb
    OR NEW.capture->'versions'->>'model' IS DISTINCT FROM NEW.model THEN
    RAISE EXCEPTION 'AI run capture identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.source_version AS version
    JOIN app.source_document AS source ON source.project_id = version.project_id AND source.id = version.source_id
    WHERE version.project_id = NEW.project_id AND version.id = NEW.prompt_source_version_id AND source.kind = 'AI_PROMPT'
      AND version.created_by = NEW.actor_id AND version.text = NEW.capture->>'prompt' AND version.content_hash = NEW.capture->>'promptHash'
  ) THEN
    RAISE EXCEPTION 'AI run prompt evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app"."enforce_ai_run"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_number integer;
  new_number integer;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.admission_day IS DISTINCT FROM OLD.admission_day
    OR NEW.prompt_source_version_id IS DISTINCT FROM OLD.prompt_source_version_id OR NEW.task_type IS DISTINCT FROM OLD.task_type
    OR NEW.model IS DISTINCT FROM OLD.model OR NEW.execution_binding IS DISTINCT FROM OLD.execution_binding OR NEW.capture_hash IS DISTINCT FROM OLD.capture_hash
    OR NEW.expected_document_revision IS DISTINCT FROM OLD.expected_document_revision OR NEW.parent_snapshot_id IS DISTINCT FROM OLD.parent_snapshot_id
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI run identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.capture IS NULL AND NEW.capture IS NOT NULL) OR (OLD.capture IS NOT NULL AND NEW.capture IS NOT NULL AND NEW.capture IS DISTINCT FROM OLD.capture)
    OR (OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.result IS NULL AND NEW.result IS NOT NULL AND OLD.state = 'SUCCEEDED')
    OR (OLD.result_hash IS NOT NULL AND NEW.result_hash IS DISTINCT FROM OLD.result_hash)
    OR (OLD.diff IS NOT NULL AND NEW.diff IS NOT NULL AND NEW.diff IS DISTINCT FROM OLD.diff) THEN
    RAISE EXCEPTION 'AI run capture and result are immutable' USING ERRCODE = '23514';
  END IF;
  -- Bodies leave only seven days after the run settled, and never from an applied run (its evidence must survive cleanup).
  IF ((OLD.capture IS NOT NULL AND NEW.capture IS NULL) OR (OLD.result IS NOT NULL AND NEW.result IS NULL))
    AND (OLD.terminal_at IS NULL OR OLD.terminal_at > CURRENT_TIMESTAMP - INTERVAL '7 days' OR OLD.disposition = 'APPLIED') THEN
    RAISE EXCEPTION 'AI run body retention boundary' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
    OR (OLD.state = 'RUNNING' AND NEW.state IN ('VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
    OR (OLD.state = 'VALIDATING' AND NEW.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
  ) THEN
    RAISE EXCEPTION 'invalid AI run transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.terminal_at IS NOT NULL AND (NEW.terminal_at IS DISTINCT FROM OLD.terminal_at OR NEW.failure_code IS DISTINCT FROM OLD.failure_code) THEN
    RAISE EXCEPTION 'terminal AI run is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.disposition IS NOT NULL AND NEW.disposition IS DISTINCT FROM OLD.disposition AND OLD.disposition <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'AI result disposition is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    RAISE EXCEPTION 'AI run cancellation intent is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.budget_state <> 'RESERVED' AND NEW.budget_state IS DISTINCT FROM OLD.budget_state THEN
    RAISE EXCEPTION 'AI run budget settlement is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_state = 'DISPATCHED' AND (NEW.dispatch_state <> 'DISPATCHED' OR NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    RAISE EXCEPTION 'AI run dispatch acknowledgement is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id AND OLD.current_attempt_id IS NOT NULL THEN
    SELECT attempt_number INTO old_number FROM app.ai_run_attempt WHERE id = OLD.current_attempt_id;
    SELECT attempt_number INTO new_number FROM app.ai_run_attempt WHERE id = NEW.current_attempt_id;
    IF new_number IS NULL OR new_number <= old_number THEN
      RAISE EXCEPTION 'the current attempt pointer only advances' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app"."enforce_ai_run_attempt"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.token IS DISTINCT FROM OLD.token OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
    RAISE EXCEPTION 'AI attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.call_may_have_started AND NOT NEW.call_may_have_started THEN
    RAISE EXCEPTION 'a possibly started call stays consumed' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens OR NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id) THEN
    RAISE EXCEPTION 'a settled AI attempt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "enforce_ai_run_insert" BEFORE INSERT ON "app"."ai_run" FOR EACH ROW EXECUTE FUNCTION "app"."enforce_ai_run_insert"();
CREATE TRIGGER "enforce_ai_run" BEFORE UPDATE ON "app"."ai_run" FOR EACH ROW EXECUTE FUNCTION "app"."enforce_ai_run"();
CREATE TRIGGER "enforce_ai_run_attempt" BEFORE UPDATE ON "app"."ai_run_attempt" FOR EACH ROW EXECUTE FUNCTION "app"."enforce_ai_run_attempt"();

-- Internal helpers: no grants; they run only inside the definer functions below, as their owner.
CREATE FUNCTION "app"."ai_actor_may_run"(p_project_id uuid, p_actor_id uuid) RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.project AS project
    JOIN app.pilot_entitlement AS entitlement ON entitlement.profile_id = project.owner_id
    WHERE project.id = p_project_id AND project.status = 'ACTIVE'
      AND entitlement.active AND entitlement.revoked_at IS NULL AND (entitlement.expires_at IS NULL OR entitlement.expires_at > clock_timestamp())
      AND (project.owner_id = p_actor_id OR EXISTS (
        SELECT 1 FROM app.project_membership AS membership
        WHERE membership.project_id = project.id AND membership.profile_id = p_actor_id AND membership.active AND membership.role = 'EDITOR'))
  );
$$;

-- One service-attributed audit event and the project's event/ai cursors, in the caller's transaction.
CREATE FUNCTION "app"."record_ai_event"(p_project_id uuid, p_run_id uuid, p_action text, p_metadata jsonb) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  next_sequence bigint;
BEGIN
  UPDATE app.project SET event_sequence = event_sequence + 1, ai_revision = event_sequence + 1 WHERE id = p_project_id RETURNING event_sequence INTO next_sequence;
  INSERT INTO app.audit_event (project_id, sequence, service_action, action, entity_refs, metadata)
  VALUES (p_project_id, next_sequence, 'ai-run', p_action, jsonb_build_object('runId', p_run_id), p_metadata);
  UPDATE app.ai_run SET last_event_sequence = next_sequence WHERE id = p_run_id;
  RETURN next_sequence;
END;
$$;

-- Lock order everywhere below: project, then the run, then the owner allowance, then the owner/day budget. Never an entitlement lock.
-- Claims the next provider call: reauthorizes, honours cancel/deadline, allows at most two attempts, consumes the reservation once
-- and persists call_may_have_started before the caller touches the network.
CREATE FUNCTION "app"."claim_ai_attempt"(p_run_id uuid)
RETURNS TABLE ("out_status" text, "out_attempt_id" uuid, "out_attempt_number" integer, "out_attempt_token" uuid, "out_attempt_deadline_at" timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  prior app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz := clock_timestamp();
  next_number integer := 1;
  claimed app.ai_run_attempt%ROWTYPE;
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN out_status := 'MISSING'; RETURN NEXT; RETURN; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF run.terminal_at IS NOT NULL THEN out_status := 'TERMINAL';
  ELSIF run.cancel_requested_at IS NOT NULL THEN out_status := 'CANCELLED';
  ELSIF clock_now >= run.deadline_at THEN out_status := 'DEADLINE';
  ELSIF run.state = 'VALIDATING' THEN out_status := 'BUSY';
  ELSIF NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN out_status := 'DENIED';
  END IF;
  IF out_status IS NOT NULL THEN RETURN NEXT; RETURN; END IF;
  IF run.current_attempt_id IS NOT NULL THEN
    SELECT * INTO prior FROM app.ai_run_attempt WHERE id = run.current_attempt_id FOR UPDATE;
    IF prior.outcome IS NULL THEN
      IF prior.deadline_at > clock_now THEN out_status := 'BUSY'; RETURN NEXT; RETURN; END IF;
      -- The previous call's window closed with no reported outcome: it may have run, so it stays consumed and is never repeated.
      UPDATE app.ai_run_attempt SET outcome = 'UNKNOWN', settled_at = clock_now WHERE id = prior.id;
    END IF;
    next_number := prior.attempt_number + 1;
  END IF;
  IF next_number > 2 THEN out_status := 'CEILING'; RETURN NEXT; RETURN; END IF;
  IF run.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = run.owner_id FOR UPDATE;
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1, consumed_runs = consumed_runs + 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  INSERT INTO app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started)
  VALUES (run.id, next_number, clock_now, LEAST(clock_now + INTERVAL '120 seconds', run.deadline_at), true)
  RETURNING * INTO claimed;
  UPDATE app.ai_run SET state = 'RUNNING', current_attempt_id = claimed.id, budget_state = 'CONSUMED' WHERE id = run.id;
  IF run.state = 'QUEUED' THEN PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_STARTED', jsonb_build_object('state', 'RUNNING')); END IF;
  out_status := 'CLAIMED'; out_attempt_id := claimed.id; out_attempt_number := claimed.attempt_number; out_attempt_token := claimed.token; out_attempt_deadline_at := claimed.deadline_at;
  RETURN NEXT;
END;
$$;

-- Records one attempt's reported outcome and, for a completed call that is still fenced in (current attempt and token, before its
-- window, not cancelled, actor still authorized), stores the already validated result and succeeds the run. Late, stale or
-- fenced output is never stored.
CREATE FUNCTION "app"."settle_ai_attempt"(
  p_run_id uuid, p_attempt_id uuid, p_attempt_token uuid, p_outcome "app"."ai_attempt_outcome", p_result jsonb, p_result_hash text,
  p_input_tokens integer, p_output_tokens integer, p_request_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  attempt app.ai_run_attempt%ROWTYPE;
  clock_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  SELECT * INTO attempt FROM app.ai_run_attempt WHERE id = p_attempt_id AND run_id = p_run_id AND token = p_attempt_token FOR UPDATE;
  IF NOT FOUND OR attempt.outcome IS NOT NULL OR run.current_attempt_id IS DISTINCT FROM attempt.id OR run.terminal_at IS NOT NULL THEN RETURN 'STALE'; END IF;
  UPDATE app.ai_run_attempt SET outcome = p_outcome, settled_at = clock_now, input_tokens = p_input_tokens, output_tokens = p_output_tokens, provider_request_id = p_request_id WHERE id = attempt.id;
  IF p_outcome <> 'COMPLETED' THEN RETURN 'RECORDED'; END IF;
  IF run.cancel_requested_at IS NOT NULL OR clock_now >= attempt.deadline_at OR NOT app.ai_actor_may_run(run.project_id, run.actor_id) THEN RETURN 'FENCED'; END IF;
  IF p_result IS NULL OR p_result_hash IS NULL THEN RAISE EXCEPTION 'a completed attempt requires its validated result' USING ERRCODE = '23514'; END IF;
  UPDATE app.ai_run SET state = 'SUCCEEDED', disposition = 'AVAILABLE', result = p_result, result_hash = p_result_hash, terminal_at = clock_now WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_SUCCEEDED', jsonb_build_object('state', 'SUCCEEDED'));
  RETURN 'SUCCEEDED';
END;
$$;

-- Terminal non-success settlement. Each state keeps its own guard: CANCELLED needs recorded intent, TIMED_OUT needs the passed deadline,
-- FAILED needs a safe code and no unreported attempt. A reservation that never reached a provider claim is released here, once.
CREATE FUNCTION "app"."finish_ai_run"(p_run_id uuid, p_state "app"."ai_run_state", p_failure_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  run app.ai_run%ROWTYPE;
  clock_now timestamptz := clock_timestamp();
BEGIN
  IF p_state NOT IN ('FAILED', 'CANCELLED', 'TIMED_OUT') THEN RAISE EXCEPTION 'unsupported terminal state' USING ERRCODE = '22023'; END IF;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  PERFORM 1 FROM app.project WHERE id = run.project_id FOR NO KEY UPDATE;
  SELECT * INTO run FROM app.ai_run WHERE id = p_run_id FOR UPDATE;
  IF run.terminal_at IS NOT NULL THEN RETURN 'TERMINAL'; END IF;
  IF (p_state = 'CANCELLED' AND run.cancel_requested_at IS NULL) OR (p_state = 'TIMED_OUT' AND clock_now < run.deadline_at)
    OR (p_state = 'FAILED' AND (p_failure_code IS NULL OR EXISTS (SELECT 1 FROM app.ai_run_attempt WHERE id = run.current_attempt_id AND outcome IS NULL))) THEN
    RETURN 'REFUSED';
  END IF;
  IF p_state <> 'FAILED' THEN
    UPDATE app.ai_run_attempt SET outcome = CASE p_state WHEN 'CANCELLED' THEN 'CANCELLED'::app.ai_attempt_outcome ELSE 'TIMED_OUT'::app.ai_attempt_outcome END, settled_at = clock_now
    WHERE run_id = run.id AND outcome IS NULL;
  END IF;
  IF run.budget_state = 'RESERVED' THEN
    PERFORM 1 FROM app.ai_owner_allowance WHERE owner_id = run.owner_id FOR UPDATE;
    UPDATE app.ai_budget_day SET reserved_runs = reserved_runs - 1 WHERE owner_id = run.owner_id AND day = run.admission_day;
  END IF;
  UPDATE app.ai_run SET state = p_state, failure_code = p_failure_code, terminal_at = clock_now,
    budget_state = CASE WHEN run.budget_state = 'RESERVED' THEN 'RELEASED'::app.ai_budget_state ELSE run.budget_state END WHERE id = run.id;
  PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RUN_' || p_state::text, jsonb_build_object('state', p_state::text));
  RETURN 'SETTLED';
END;
$$;

-- Bounded body expiry: seven days after a run settled, drop its capture/result bodies (never an applied run's) and mark an unused
-- result EXPIRED. Run identity, hashes, attribution, usage and prompt/cited evidence stay.
CREATE FUNCTION "app"."expire_ai_run_bodies"(p_dry_run boolean, p_batch_size integer)
RETURNS TABLE ("expiredResults" integer, "clearedBodies" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  limit_rows integer := LEAST(GREATEST(p_batch_size, 1), 100);
  clock_now timestamptz := clock_timestamp();
  candidate record;
  run app.ai_run%ROWTYPE;
BEGIN
  PERFORM set_config('statement_timeout', '5000', true);
  "expiredResults" := 0; "clearedBodies" := 0;
  IF p_dry_run THEN
    SELECT count(*) FILTER (WHERE disposition = 'AVAILABLE')::integer, count(*) FILTER (WHERE disposition IS DISTINCT FROM 'AVAILABLE')::integer INTO "expiredResults", "clearedBodies"
    FROM (SELECT disposition FROM app.ai_run WHERE terminal_at <= clock_now - INTERVAL '7 days' AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY terminal_at, id LIMIT limit_rows) AS picked;
    RETURN NEXT; RETURN;
  END IF;
  -- Project order first, so concurrent sweeps and the other functions above acquire locks in one order.
  FOR candidate IN SELECT id, project_id FROM app.ai_run WHERE terminal_at <= clock_now - INTERVAL '7 days' AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' ORDER BY project_id, id LIMIT limit_rows LOOP
    PERFORM 1 FROM app.project WHERE id = candidate.project_id FOR NO KEY UPDATE;
    SELECT * INTO run FROM app.ai_run WHERE id = candidate.id AND terminal_at <= clock_now - INTERVAL '7 days' AND (capture IS NOT NULL OR result IS NOT NULL) AND disposition IS DISTINCT FROM 'APPLIED' FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE app.ai_run SET capture = NULL, result = NULL, diff = NULL, disposition = CASE WHEN run.disposition = 'AVAILABLE' THEN 'EXPIRED'::app.ai_result_disposition ELSE run.disposition END WHERE id = run.id;
    IF run.disposition = 'AVAILABLE' THEN
      "expiredResults" := "expiredResults" + 1;
      PERFORM app.record_ai_event(run.project_id, run.id, 'AI_RESULT_EXPIRED', jsonb_build_object('state', run.state::text));
    ELSE
      "clearedBodies" := "clearedBodies" + 1;
    END IF;
  END LOOP;
  RETURN NEXT;
END;
$$;

ALTER TABLE "app"."source_document" OWNER TO app_migrator;
ALTER TABLE "app"."source_version" OWNER TO app_migrator;
ALTER TABLE "app"."ai_owner_allowance" OWNER TO app_migrator;
ALTER TABLE "app"."ai_budget_day" OWNER TO app_migrator;
ALTER TABLE "app"."ai_run" OWNER TO app_migrator;
ALTER TABLE "app"."ai_run_attempt" OWNER TO app_migrator;
ALTER FUNCTION "app"."reject_source_version_update"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_source_document"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_source_head"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_ai_run_insert"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_ai_run"() OWNER TO app_migrator;
ALTER FUNCTION "app"."enforce_ai_run_attempt"() OWNER TO app_migrator;
ALTER FUNCTION "app"."ai_actor_may_run"(uuid, uuid) OWNER TO app_migrator;
ALTER FUNCTION "app"."record_ai_event"(uuid, uuid, text, jsonb) OWNER TO app_migrator;
ALTER FUNCTION "app"."claim_ai_attempt"(uuid) OWNER TO app_migrator;
ALTER FUNCTION "app"."settle_ai_attempt"(uuid, uuid, uuid, "app"."ai_attempt_outcome", jsonb, text, integer, integer, text) OWNER TO app_migrator;
ALTER FUNCTION "app"."finish_ai_run"(uuid, "app"."ai_run_state", text) OWNER TO app_migrator;
ALTER FUNCTION "app"."expire_ai_run_bodies"(boolean, integer) OWNER TO app_migrator;

REVOKE ALL ON TYPE "app"."source_kind", "app"."ai_task_kind", "app"."ai_run_state", "app"."ai_result_disposition", "app"."ai_dispatch_state", "app"."ai_budget_state", "app"."ai_attempt_outcome" FROM PUBLIC;
REVOKE ALL ON TABLE "app"."source_document", "app"."source_version", "app"."ai_owner_allowance", "app"."ai_budget_day", "app"."ai_run", "app"."ai_run_attempt" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."reject_source_version_update"(), "app"."enforce_source_document"(), "app"."enforce_source_head"(), "app"."enforce_ai_run_insert"(), "app"."enforce_ai_run"(), "app"."enforce_ai_run_attempt"(),
  "app"."ai_actor_may_run"(uuid, uuid), "app"."record_ai_event"(uuid, uuid, text, jsonb), "app"."claim_ai_attempt"(uuid),
  "app"."settle_ai_attempt"(uuid, uuid, uuid, "app"."ai_attempt_outcome", jsonb, text, integer, integer, text),
  "app"."finish_ai_run"(uuid, "app"."ai_run_state", text), "app"."expire_ai_run_bodies"(boolean, integer) FROM PUBLIC;

GRANT USAGE ON TYPE "app"."source_kind", "app"."ai_task_kind", "app"."ai_run_state", "app"."ai_result_disposition", "app"."ai_dispatch_state", "app"."ai_budget_state", "app"."ai_attempt_outcome" TO app_web, app_worker;
-- Web: admit (insert evidence, run, allowance and reservation), record cancel intent and read. It cannot rewrite evidence, capture or results.
GRANT SELECT, INSERT ON "app"."source_document", "app"."source_version", "app"."ai_owner_allowance", "app"."ai_budget_day", "app"."ai_run" TO app_web;
GRANT SELECT ON "app"."ai_run_attempt" TO app_web;
GRANT UPDATE ("current_version_id", "version", "last_event_sequence", "updated_at") ON "app"."source_document" TO app_web;
GRANT UPDATE ("reserved_runs") ON "app"."ai_budget_day" TO app_web;
GRANT UPDATE ("cancel_requested_at", "last_event_sequence") ON "app"."ai_run" TO app_web;
GRANT UPDATE ("ai_revision") ON "app"."project" TO app_web;
-- Worker: read, record dispatch acknowledgements, and call the fenced functions. No other write path.
GRANT SELECT ON "app"."source_document", "app"."source_version", "app"."ai_owner_allowance", "app"."ai_budget_day", "app"."ai_run", "app"."ai_run_attempt" TO app_worker;
GRANT UPDATE ("dispatch_state", "task_id", "dispatch_lease_until", "next_dispatch_at") ON "app"."ai_run" TO app_worker;
GRANT EXECUTE ON FUNCTION "app"."claim_ai_attempt"(uuid), "app"."settle_ai_attempt"(uuid, uuid, uuid, "app"."ai_attempt_outcome", jsonb, text, integer, integer, text),
  "app"."finish_ai_run"(uuid, "app"."ai_run_state", text), "app"."expire_ai_run_bodies"(boolean, integer) TO app_worker;
