-- Retain complete before/after records from valid 2 MiB drafts, including citations and retired trace links.
ALTER TABLE app.ai_suggestion_application
  DROP CONSTRAINT ai_application_bounds,
  ADD CONSTRAINT ai_application_bounds CHECK (
  result_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(selected_operations) = 'array' AND jsonb_array_length(selected_operations) BETWEEN 1 AND 100
  AND jsonb_typeof(actual_operations) = 'array' AND jsonb_array_length(actual_operations) = jsonb_array_length(selected_operations)
  AND octet_length(selected_operations::text) <= 131072 AND octet_length(actual_operations::text) <= 262144
  AND jsonb_typeof(id_map) = 'object' AND octet_length(id_map::text) <= 65536
  AND jsonb_typeof(created_id_map) = 'object' AND octet_length(created_id_map::text) <= 65536
  AND jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 5242880
  AND cardinality(source_version_ids) BETWEEN 1 AND 201
  AND before_document_revision BETWEEN 1 AND 2147483647 AND after_document_revision BETWEEN before_document_revision AND before_document_revision::bigint + 1
  AND before_layout_revision BETWEEN 1 AND 2147483647 AND after_layout_revision BETWEEN before_layout_revision AND before_layout_revision::bigint + 1
);
