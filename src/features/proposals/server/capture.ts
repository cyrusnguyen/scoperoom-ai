import { lockDraft } from "../../drafts/server/execute-command.ts";
import type { ProjectRow, Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { AI_LIMITS, type CapturedConversation, type StartRunInput } from "../contracts/tasks.ts";
import { captureInput, type SavedSource } from "../domain/capture.ts";
import { buildConversation } from "../domain/conversation.ts";
import { inspectRun, type ApplicabilityRow } from "./applicability.ts";

const CAPTURE_FAILURES = new Set(["INVALID_INPUT", "INVALID_SOURCE_REFERENCE", "DRAFT_REPLACED", "STALE_DOCUMENT_REVISION", "BASELINE_CHANGED", "CONFLICT", "LIMIT_EXCEEDED"]);

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

/**
 * The run a follow-up continues: this project only, SUCCEEDED, bodies retained and still valid. Anything else is one refusal, so
 * an id from another project or a guess reveals nothing. Read without a lock: a terminal run's capture and result never change.
 */
async function savedConversation(tx: Transaction, project: ProjectRow, input: StartRunInput): Promise<CapturedConversation | undefined> {
  const runId = input.context.continuesRunId;
  if (!runId) return undefined;
  const [row] = await tx.$queryRaw<ApplicabilityRow[]>`
    SELECT run.id, run.task_type::text AS task_type, run.state::text AS state, run.disposition::text AS disposition,
      run.cancel_requested_at, run.draft_id, run.expected_document_revision, run.parent_snapshot_id, run.terminal_at,
      run.capture, run.capture_hash, run.result, run.result_hash, draft.document_revision AS current_revision,
      COALESCE(run.terminal_at + INTERVAL '7 days' <= clock_timestamp(), false) AS body_expired, false AS sources_changed
    FROM app.ai_run run LEFT JOIN app.scope_draft draft ON draft.id = run.draft_id AND draft.project_id = run.project_id
    WHERE run.project_id = ${project.id}::uuid AND run.id = ${runId}::uuid`;
  const bodies = row && row.state === "SUCCEEDED" && !row.body_expired ? inspectRun(row, project) : null;
  if (!row || !bodies?.capture || !bodies.result) throw new ProjectError("AI_CONVERSATION_UNAVAILABLE");
  try {
    return buildConversation({ id: row.id, capture: bodies.capture, result: bodies.result, disposition: row.disposition });
  } catch (error) {
    if (error instanceof Error && error.message === "LIMIT_EXCEEDED") throw new ProjectError("LIMIT_EXCEEDED", { limit: "CONVERSATION_BYTES" });
    throw error;
  }
}

/** Locks the current draft and reads exactly the saved revision, baseline and cited sources the request names, then builds the immutable capture. */
export async function captureSaved(tx: Transaction, project: ProjectRow, input: StartRunInput, model: string) {
  if (input.draftId !== project.currentDraftId) throw new ProjectError("DRAFT_REPLACED");
  const draft = await lockDraft(tx, project, input.draftId);
  const [baseline] = await tx.$queryRaw<Array<{ snapshot_id: string | null }>>`SELECT approved_snapshot_id::text AS snapshot_id FROM app.project WHERE id = ${project.id}::uuid`;
  const sources = await savedSources(tx, project.id, input);
  const conversation = await savedConversation(tx, project, input);
  try {
    return captureInput({
      projectId: project.id, draftId: input.draftId, documentRevision: draft.documentRevision, parentSnapshotId: baseline?.snapshot_id ?? null,
      document: draft.draft.document, sources, model, ...(conversation ? { conversation } : {}),
    }, input);
  } catch (error) {
    if (error instanceof Error && CAPTURE_FAILURES.has(error.message)) throw new ProjectError(error.message as ConstructorParameters<typeof ProjectError>[0]);
    throw error;
  }
}
