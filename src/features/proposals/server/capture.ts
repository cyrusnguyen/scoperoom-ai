import type { Prisma } from "../../../../prisma/generated/client.ts";
import { storedDraft } from "../../drafts/server/execute-command.ts";
import type { ProjectRow, Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { AI_LIMITS, type StartRunInput } from "../contracts/tasks.ts";
import { captureInput, type SavedSource } from "../domain/capture.ts";

const CAPTURE_FAILURES = new Set(["INVALID_INPUT", "DRAFT_REPLACED", "STALE_DOCUMENT_REVISION", "CONFLICT", "LIMIT_EXCEEDED"]);

/** Explicit same-project versions with their documents share-locked (children after the draft). Sizes are checked before any text loads. */
async function savedSources(tx: Transaction, projectId: string, input: StartRunInput): Promise<SavedSource[]> {
  const ids = input.context.sources.map((source) => source.sourceVersionId);
  if (!ids.length) return [];
  const heads = await tx.$queryRaw<Array<{ id: string; source_id: string; current_version_id: string | null; bytes: number }>>`
    SELECT version.id, version.source_id, source.current_version_id, version.utf8_byte_count AS bytes
    FROM app.source_version version JOIN app.source_document source ON source.project_id = version.project_id AND source.id = version.source_id
    WHERE version.project_id = ${projectId}::uuid AND version.id = ANY(${ids}::uuid[])
    ORDER BY version.id FOR SHARE OF source`;
  if (heads.reduce((sum, row) => sum + row.bytes, 0) > AI_LIMITS.captureBytes) throw new ProjectError("LIMIT_EXCEEDED", { limit: "CAPTURE_BYTES" });
  const texts = await tx.$queryRaw<Array<{ id: string; title: string; text: string; content_hash: string }>>`
    SELECT id, title, text, content_hash FROM app.source_version WHERE project_id = ${projectId}::uuid AND id = ANY(${heads.map((row) => row.id)}::uuid[])`;
  const byId = new Map(texts.map((row) => [row.id, row]));
  return heads.flatMap((head) => {
    const version = byId.get(head.id);
    return version && head.current_version_id ? [{
      projectId, sourceId: head.source_id, sourceVersionId: head.id, currentVersionId: head.current_version_id, title: version.title, text: version.text, contentHash: version.content_hash,
    }] : [];
  });
}

/** Locks the current draft and reads exactly the saved revision, baseline and cited sources the request names, then builds the immutable capture. */
export async function captureSaved(tx: Transaction, project: ProjectRow, input: StartRunInput, model: string) {
  if (input.draftId !== project.currentDraftId) throw new ProjectError("DRAFT_REPLACED");
  const [draft] = await tx.$queryRaw<Array<{ status: string; document_revision: number; layout_revision: number; document_json: Prisma.JsonValue; layout_json: Prisma.JsonValue }>>`
    SELECT status::text AS status, document_revision, layout_revision, document_json, layout_json
    FROM app.scope_draft WHERE id = ${input.draftId}::uuid AND project_id = ${project.id}::uuid FOR UPDATE`;
  if (!draft || draft.status !== "EDITABLE") throw new ProjectError("DRAFT_REPLACED");
  const [baseline] = await tx.$queryRaw<Array<{ snapshot_id: string | null }>>`SELECT approved_snapshot_id::text AS snapshot_id FROM app.project WHERE id = ${project.id}::uuid`;
  const sources = await savedSources(tx, project.id, input);
  try {
    return captureInput({
      projectId: project.id, draftId: input.draftId, documentRevision: draft.document_revision, parentSnapshotId: baseline?.snapshot_id ?? null,
      document: storedDraft(draft.document_json, draft.layout_json).document, sources, model,
    }, input);
  } catch (error) {
    if (error instanceof Error && CAPTURE_FAILURES.has(error.message)) throw new ProjectError(error.message as ConstructorParameters<typeof ProjectError>[0]);
    throw error;
  }
}
