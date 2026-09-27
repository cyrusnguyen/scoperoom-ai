-- Stage 03: the web runtime saves draft content, positions and their revisions. Identity, ownership, status and
-- schema version stay unwritable, and the worker keeps read-only access.
GRANT UPDATE ("document_json", "layout_json", "document_revision", "layout_revision", "updated_at") ON "app"."scope_draft" TO app_web;
