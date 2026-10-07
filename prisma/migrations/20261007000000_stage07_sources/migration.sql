-- Stage 07: the sources family cursor (Data 01 "AI, receipts and audit") and metadata edits of user-managed sources.
ALTER TABLE "app"."project"
  ADD COLUMN "sources_revision" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "project_sources_revision_safe_integer" CHECK ("sources_revision" BETWEEN 0 AND 9007199254740991);

GRANT UPDATE ("sources_revision") ON "app"."project" TO app_web;
GRANT UPDATE ("archived", "display_nickname") ON "app"."source_document" TO app_web;
