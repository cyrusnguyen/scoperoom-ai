import { randomUUID } from "node:crypto";
import { id, keys, object, version } from "../../drafts/contracts/strict.ts";
import { asJson, graphFailure, lockDraft, nextRevision, requireStoredSize } from "../../drafts/server/execute-command.ts";
import { recordEvent, requestHash } from "../../projects/server/access.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseApplyRunInput, type AppliedRun, type ApplyRunInput } from "../contracts/tasks.ts";
import { canonicalJson, sha256 } from "../domain/capture.ts";
import { applyProposal } from "../domain/proposal-diff.ts";
import { ResultError } from "../domain/validate-result.ts";
import { validatedCapture, type CaptureRow } from "./applicability.ts";
import { applicationMutation, available, cursor, lockRun } from "./application.ts";

const OPERATION = "AI_APPLY_V1";
export function parseAppliedRun(value: unknown): Omit<AppliedRun, "replayed"> {
  try {
    const r = object(value); keys(r, ["applicationId", "runId", "draftId", "documentRevision", "layoutRevision", "eventSequence", "aiRevision"]);
    return { applicationId: id(r.applicationId), runId: id(r.runId), draftId: id(r.draftId), documentRevision: version(r.documentRevision), layoutRevision: version(r.layoutRevision), eventSequence: cursor(r.eventSequence), aiRevision: cursor(r.aiRevision) };
  } catch { throw new ProjectError("UNAVAILABLE"); }
}
export async function applyRun(identity: ProjectIdentity, projectId: string, runId: string, raw: ApplyRunInput): Promise<AppliedRun> {
  if (!uuid.test(projectId) || !uuid.test(runId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase(); runId = runId.toLowerCase();
  let input: ApplyRunInput;
  try { const r = object(raw); const { key, ...body } = r; if (typeof key !== "string") throw new Error(); input = parseApplyRunInput(body, key); }
  catch { throw new ProjectError("INVALID_INPUT"); }
  const { key, ...body } = input;
  const hash = requestHash(OPERATION, { projectId, runId, ...body });
  return applicationMutation(identity, projectId, runId, key, OPERATION, hash, parseAppliedRun, async (tx, project, actorId) => {
    const [prior] = await tx.$queryRaw<Array<{ id: string; draft_id: string }>>`SELECT id, draft_id FROM app.ai_suggestion_application WHERE run_id = ${runId}::uuid`;
    if (prior) throw new ProjectError("AI_RUN_CONSUMED", { applicationId: prior.id, runId, draftId: prior.draft_id });
    const [manifest] = await tx.$queryRaw<Array<CaptureRow>>`SELECT task_type::text AS task_type, draft_id, expected_document_revision, parent_snapshot_id, capture, capture_hash FROM app.ai_run WHERE id = ${runId}::uuid AND project_id = ${project.id}::uuid`;
    if (!manifest || input.draftId !== manifest.draft_id) throw new ProjectError("DRAFT_REPLACED");
    const saved = await lockDraft(tx, project, input.draftId);
    const captured = validatedCapture(manifest);
    if (!captured) throw new ProjectError("AI_RESULT_UNAVAILABLE");
    const sources = captured.sources;
    const heads = sources.length ? await tx.$queryRaw<Array<{ id: string; current_version_id: string | null }>>`
      SELECT id, current_version_id FROM app.source_document WHERE project_id = ${project.id}::uuid AND id = ANY(${sources.map(source => source.sourceId)}::uuid[]) ORDER BY id FOR SHARE` : [];
    const run = await lockRun(tx, project.id, runId);
    await available(tx, run, input.resultHash);
    const capture = validatedCapture(run);
    if (!capture) throw new ProjectError("AI_RESULT_UNAVAILABLE");
    if (sha256(canonicalJson(run.result)) !== run.result_hash) throw new ProjectError("UNAVAILABLE");
    if (capture.draftId !== input.draftId || capture.draftId !== run.draft_id) throw new ProjectError("DRAFT_REPLACED");
    if (input.expectedDocumentRevision !== capture.documentRevision || run.expected_document_revision !== capture.documentRevision || saved.documentRevision !== capture.documentRevision) throw new ProjectError("STALE_DOCUMENT_REVISION");
    if (input.expectedParentSnapshotId !== capture.parentSnapshotId || run.parent_snapshot_id !== capture.parentSnapshotId || project.approvedSnapshotId !== capture.parentSnapshotId) throw new ProjectError("BASELINE_CHANGED");
    if (capture.sources.some(source => heads.find(head => head.id === source.sourceId)?.current_version_id !== source.expectedCurrentVersionId)) throw new ProjectError("INVALID_SOURCE_REFERENCE");
    let applied: ReturnType<typeof applyProposal>;
    try { applied = applyProposal(saved.draft, capture, run.result!, input.selectedOperationIds, randomUUID); }
    catch (error) {
      if (error instanceof ResultError) throw new ProjectError("AI_RESULT_UNAVAILABLE");
      if (error instanceof Error && error.message === "DEPENDENCY_CONFLICT") throw new ProjectError("DEPENDENCY_CONFLICT");
      graphFailure(error);
    }
    const documentRevision = applied!.documentChanged ? nextRevision(saved.documentRevision) : saved.documentRevision;
    const layoutRevision = applied!.layoutChanged ? nextRevision(saved.layoutRevision) : saved.layoutRevision;
    await requireStoredSize(tx, applied!.document, applied!.layout);
    // Capacity checks and pure transforms may take time; expiry uses the clock after all locks and again before writes.
    await available(tx, run, input.resultHash);
    await tx.scopeDraft.update({ where: { id: saved.id }, data: { documentJson: asJson(applied!.document), layoutJson: asJson(applied!.layout), documentRevision, layoutRevision }, select: { id: true } });
    const applicationId = randomUUID();
    const records = (document: typeof applied.document) => applied!.changedIds.flatMap(id => {
      const record = document.flows[id] ?? document.nodes[id] ?? document.edges[id]; return record ? [record] : [];
    });
    const selected = run.result!.kind === "proposal" ? run.result!.operations.filter(operation => input.selectedOperationIds.includes(operation.id)) : [];
    const sourceIds = [...new Set([run.prompt_source_version_id, ...capture.sources.flatMap(source => [source.sourceVersionId, source.expectedCurrentVersionId])])].sort();
    const evidence = { changedIds: applied!.changedIds, before: records(saved.draft.document), after: records(applied!.document), assumptions: run.result!.kind === "proposal" ? run.result!.assumptions : [], citations: run.result!.kind === "proposal" ? run.result!.citations : [] };
    const [bounded] = await tx.$queryRaw<Array<{ allowed: boolean }>>`SELECT
      octet_length(${JSON.stringify(selected)}::jsonb::text) <= 131072 AND octet_length(${JSON.stringify(applied!.actualCommands)}::jsonb::text) <= 262144
      AND octet_length(${JSON.stringify(applied!.idMap)}::jsonb::text) <= 65536 AND octet_length(${JSON.stringify(applied!.createdIdMap)}::jsonb::text) <= 65536
      AND octet_length(${JSON.stringify(evidence)}::jsonb::text) <= 1048576 AS allowed`;
    if (!bounded?.allowed) throw new ProjectError("LIMIT_EXCEEDED");
    await tx.$executeRaw`INSERT INTO app.ai_suggestion_application
      (id, project_id, run_id, draft_id, actor_id, prompt_source_version_id, result_hash, selected_operations, actual_operations, id_map, created_id_map, evidence,
       source_version_ids, before_document_revision, after_document_revision, before_layout_revision, after_layout_revision)
      VALUES (${applicationId}::uuid, ${project.id}::uuid, ${runId}::uuid, ${saved.id}::uuid, ${actorId}::uuid, ${run.prompt_source_version_id}::uuid, ${run.result_hash},
        ${JSON.stringify(selected)}::jsonb, ${JSON.stringify(applied!.actualCommands)}::jsonb, ${JSON.stringify(applied!.idMap)}::jsonb, ${JSON.stringify(applied!.createdIdMap)}::jsonb,
        ${JSON.stringify(evidence)}::jsonb,
        ${sourceIds}::uuid[], ${saved.documentRevision}, ${documentRevision}, ${saved.layoutRevision}, ${layoutRevision})`;
    for (const sourceId of sourceIds) await tx.$executeRaw`INSERT INTO app.ai_application_source (project_id, application_id, source_version_id) VALUES (${project.id}::uuid, ${applicationId}::uuid, ${sourceId}::uuid)`;
    await tx.$executeRaw`UPDATE app.ai_run SET disposition = 'APPLIED' WHERE id = ${runId}::uuid`;
    const sequence = await recordEvent(tx, project, actorId, "AI_PROPOSAL_APPLIED", [{ kind: "DRAFT", id: saved.id }, { kind: "AI_RUN", id: runId }], { applicationId, documentRevision, layoutRevision, changedCount: applied!.changedIds.length });
    await tx.$executeRaw`UPDATE app.project SET ai_revision = ${sequence}::bigint WHERE id = ${project.id}::uuid`;
    await tx.$executeRaw`UPDATE app.ai_run SET last_event_sequence = ${sequence}::bigint WHERE id = ${runId}::uuid`;
    return { applicationId, runId, draftId: saved.id, documentRevision, layoutRevision, eventSequence: Number(sequence), aiRevision: Number(sequence) };
  });
}
