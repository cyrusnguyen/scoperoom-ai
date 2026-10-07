-- Stage 07: the sources family cursor (Data 01 "AI, receipts and audit") and metadata edits of user-managed sources.
ALTER TABLE "app"."project"
  ADD COLUMN "sources_revision" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "project_sources_revision_safe_integer" CHECK ("sources_revision" BETWEEN 0 AND 9007199254740991);

GRANT UPDATE ("sources_revision") ON "app"."project" TO app_web;
GRANT UPDATE ("archived", "display_nickname") ON "app"."source_document" TO app_web;

-- Graph promotion origin (Data 01 "Evidence budgets and immutable origin"): a real same-project draft FK, the selected graph ids,
-- and the copied-text hash and promoter bound to the version's own columns. Every other source keeps a null origin.
-- The draft FK is deferred so deleting a whole project (drafts and versions cascade separately) passes while a lone draft delete is still refused.
-- The selected ids of a whole flow (200 steps, 400 connections) need about 23 KB, so the old 4 KiB origin cap grows to 32 KiB.
ALTER TABLE "app"."source_version"
  ADD COLUMN "origin_draft_id" UUID,
  DROP CONSTRAINT "source_version_origin_size",
  ADD CONSTRAINT "source_version_origin_size" CHECK ("origin" IS NULL OR (jsonb_typeof("origin") = 'object' AND octet_length("origin"::text) <= 32768)),
  ADD CONSTRAINT "source_version_origin_draft_fkey" FOREIGN KEY ("project_id", "origin_draft_id") REFERENCES "app"."scope_draft"("project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  -- COALESCE: a missing key makes a comparison NULL, and PostgreSQL accepts a NULL CHECK, so the whole predicate must be TRUE.
  ADD CONSTRAINT "source_version_origin_binding" CHECK (COALESCE(
    ("origin" IS NULL AND "origin_draft_id" IS NULL)
    OR ("origin_draft_id" IS NOT NULL
      AND "origin" ?& ARRAY['type', 'draftId', 'documentRevision', 'flowId', 'nodeIds', 'edgeIds', 'copiedTextHash', 'promotedBy']
      AND ("origin" - ARRAY['type', 'draftId', 'documentRevision', 'flowId', 'nodeIds', 'edgeIds', 'copiedTextHash', 'promotedBy']) = '{}'::jsonb
      AND "origin"->>'type' = 'GRAPH' AND "origin"->>'draftId' = "origin_draft_id"::text
      AND jsonb_typeof("origin"->'documentRevision') = 'number' AND jsonb_typeof("origin"->'flowId') = 'string'
      AND jsonb_typeof("origin"->'nodeIds') = 'array' AND jsonb_typeof("origin"->'edgeIds') = 'array'
      AND "origin"->>'copiedTextHash' = "content_hash" AND "origin"->>'promotedBy' = "created_by"::text),
    false));
