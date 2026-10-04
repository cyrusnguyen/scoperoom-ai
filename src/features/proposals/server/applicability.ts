import { Prisma } from "../../../../prisma/generated/client.ts";
import { LIMITS, emptyDraft, parseDocument } from "../../drafts/contracts/scope-document.ts";
import type { ProjectRow, Transaction } from "../../projects/server/access.ts";
import { AI_LIMITS, CAPTURE_SCHEMA_VERSION, type CapturedInput, type ProposalDiff, type RunApplicability, type RunApplicabilityReason, type RunDisposition, type RunState, type TaskKind, type ValidatedProposal } from "../contracts/tasks.ts";
import { canonicalJson, captureInput, jsonbTextBytes, sha256 } from "../domain/capture.ts";
import { proposalDiff } from "../domain/proposal-diff.ts";
import { validateResult } from "../domain/validate-result.ts";

export type ApplicabilityRow = {
  id: string; task_type: TaskKind; state: RunState; disposition: RunDisposition | null; cancel_requested_at: Date | null;
  draft_id: string; expected_document_revision: number; parent_snapshot_id: string | null; terminal_at: Date | null;
  capture: CapturedInput | null; capture_hash: string; result: ValidatedProposal | null; result_hash: string | null;
  current_revision: number | null; body_expired: boolean; sources_changed: boolean;
};

/** Text comparisons fail closed for malformed older source identities, without unsafe JSON-to-UUID casts. */
export const sourcesChanged = Prisma.sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(run.capture->'sources') = 'array' THEN run.capture->'sources' ELSE '[]'::jsonb END) captured
  LEFT JOIN app.source_document source ON source.project_id = run.project_id AND source.id::text = captured->>'sourceId'
  WHERE source.current_version_id::text IS DISTINCT FROM captured->>'expectedCurrentVersionId' OR source.id IS NULL)`;

/** Stored bodies are immutable but older validation rules may have admitted unusable proposals. Never expose those as Apply authority. */
export function inspectRun(row: ApplicabilityRow, project: Pick<ProjectRow, "status" | "currentDraftId" | "approvedSnapshotId">) {
  let capture: CapturedInput | null = row.capture, result: ValidatedProposal | null = null, diff: ProposalDiff | null = null;
  let invalidCapture = false, invalidResult = false;
  if (capture) {
    try {
      if (capture.schemaVersion !== CAPTURE_SCHEMA_VERSION || capture.taskType !== row.task_type || capture.draftId !== row.draft_id
        || capture.documentRevision !== row.expected_document_revision || capture.parentSnapshotId !== row.parent_snapshot_id
        || jsonbTextBytes(capture) > AI_LIMITS.captureBytes || sha256(canonicalJson(capture)) !== row.capture_hash
        || sha256(capture.prompt) !== capture.promptHash || sha256(canonicalJson(capture.graph)) !== capture.graphHash
        || Object.keys(capture.limits).sort().join(",") !== "maxGraphEdges,maxGraphNodes,maxInputTokens,maxOutputTokens,operations,resultBytes"
        || Object.entries(capture.limits).some(([key, value]) => AI_LIMITS[key as keyof typeof AI_LIMITS] !== value)
        || !Array.isArray(capture.graph.flows) || !Array.isArray(capture.graph.nodes) || !Array.isArray(capture.graph.edges)
        || capture.graph.flows.length > LIMITS.flows || capture.graph.nodes.length > LIMITS.nodes || capture.graph.edges.length > LIMITS.edges
        || !Array.isArray(capture.sources) || !Array.isArray(capture.graph.boundaryNodeIds)
        || typeof capture.versions.model !== "string" || typeof capture.versions.prompt !== "string") throw new Error();
      // Reuse the document parser and capture builder to verify exact stored structure/scope, including read-only boundary flags.
      const document = parseDocument({ ...emptyDraft().document,
        flows: Object.fromEntries(capture.graph.flows.map(flow => [flow.id, { ...flow, confirmation: null, verificationMethod: null }])),
        nodes: Object.fromEntries(capture.graph.nodes.map(({ readOnly, ...node }) => { void readOnly; return [node.id, { ...node, origin: "HUMAN", sourceRefs: [] }]; })),
        edges: Object.fromEntries(capture.graph.edges.map(edge => [edge.id, { ...edge, origin: "HUMAN", sourceRefs: [] }])),
      });
      const projectId = "00000000-0000-4000-8000-000000000000";
      const rebuilt = captureInput({ projectId, draftId: capture.draftId, documentRevision: capture.documentRevision, parentSnapshotId: capture.parentSnapshotId,
        document, sources: capture.sources.map(source => ({ ...source, projectId, currentVersionId: source.expectedCurrentVersionId })), model: capture.versions.model },
      { key: "stored-capture", taskType: capture.taskType, prompt: capture.prompt, draftId: capture.draftId, expectedDocumentRevision: capture.documentRevision,
        expectedParentSnapshotId: capture.parentSnapshotId, context: { selection: capture.selection, sources: capture.sources.map(source => ({ sourceVersionId: source.sourceVersionId, expectedCurrentVersionId: source.expectedCurrentVersionId })) } });
      rebuilt.capture.versions.prompt = capture.versions.prompt; // Historical prompt versions are attribution, not a request to recapture.
      if (canonicalJson(rebuilt.capture) !== canonicalJson(capture)) throw new Error();
    } catch { capture = null; invalidCapture = true; }
  }
  if (row.result && capture) {
    try {
      if (jsonbTextBytes(row.result) > AI_LIMITS.resultBytes || sha256(canonicalJson(row.result)) !== row.result_hash) throw new Error();
      result = validateResult(capture, row.result);
      // Validation must preserve the exact stored result; old no-change proposals are not silently converted into a new result.
      if (canonicalJson(result) !== canonicalJson(row.result)) throw new Error();
      if (result.kind === "proposal") diff = proposalDiff(capture, result, result.operations.map(operation => operation.id));
    } catch { result = null; diff = null; invalidResult = true; }
  }
  let applicability: RunApplicability = "UNAVAILABLE";
  let applicabilityReasons: RunApplicabilityReason[];
  if (row.disposition === "APPLIED") applicabilityReasons = ["APPLIED"];
  else if (row.disposition === "DISCARDED") applicabilityReasons = ["DISCARDED"];
  else if (row.disposition === "EXPIRED" || row.body_expired) applicabilityReasons = ["EXPIRED"];
  else if (project.status !== "ACTIVE") applicabilityReasons = ["PROJECT_INACTIVE"];
  else if (row.cancel_requested_at) applicabilityReasons = ["CANCEL_REQUESTED"];
  else if (row.state !== "SUCCEEDED" || row.disposition !== "AVAILABLE") applicabilityReasons = ["NOT_SUCCEEDED"];
  else if (invalidCapture) applicabilityReasons = ["INVALID_CAPTURE"];
  else if (invalidResult) applicabilityReasons = ["INVALID_RESULT"];
  else if (!capture || !result || !row.terminal_at) applicabilityReasons = ["BODY_UNAVAILABLE"];
  else if (result.kind !== "proposal") applicabilityReasons = ["CLARIFICATION"];
  else {
    applicabilityReasons = [];
    if (project.currentDraftId !== row.draft_id) applicabilityReasons.push("DRAFT_REPLACED");
    if (row.current_revision !== row.expected_document_revision) applicabilityReasons.push("DOCUMENT_CHANGED");
    if (project.approvedSnapshotId !== row.parent_snapshot_id) applicabilityReasons.push("BASELINE_CHANGED");
    if (row.sources_changed) applicabilityReasons.push("SOURCE_HEAD_CHANGED");
    applicability = applicabilityReasons.length ? "STALE" : "APPLICABLE";
  }
  return { capture, result, diff, applicability, applicabilityReasons };
}

/** Bounded pages of plausible current candidates, never all historical capture bodies in memory. Stop as soon as the quota is full. */
export async function applicableCapacityFull(tx: Transaction, project: ProjectRow): Promise<boolean> {
  let after: string | null = null, applicable = 0;
  while (true) {
    const rows: ApplicabilityRow[] = await tx.$queryRaw<ApplicabilityRow[]>`
      SELECT run.id, run.task_type::text AS task_type, run.state::text AS state, run.disposition::text AS disposition,
        run.cancel_requested_at, run.draft_id, run.expected_document_revision, run.parent_snapshot_id, run.terminal_at,
        run.capture, run.capture_hash, run.result, run.result_hash, draft.document_revision AS current_revision,
        false AS body_expired, ${sourcesChanged} AS sources_changed
      FROM app.ai_run run JOIN app.scope_draft draft ON draft.id = run.draft_id AND draft.project_id = run.project_id
      WHERE run.project_id = ${project.id}::uuid AND run.state = 'SUCCEEDED' AND run.disposition = 'AVAILABLE'
        AND run.cancel_requested_at IS NULL AND run.terminal_at + INTERVAL '7 days' > clock_timestamp()
        AND run.capture IS NOT NULL AND run.result->>'kind' = 'proposal'
        AND run.draft_id = ${project.currentDraftId}::uuid AND run.expected_document_revision = draft.document_revision
        AND run.parent_snapshot_id IS NOT DISTINCT FROM ${project.approvedSnapshotId}::uuid AND NOT (${sourcesChanged})
        ${after ? Prisma.sql`AND run.id > ${after}::uuid` : Prisma.empty}
      ORDER BY run.id LIMIT ${AI_LIMITS.applicableResults}`;
    for (const row of rows) if (inspectRun(row, project).applicability === "APPLICABLE" && ++applicable >= AI_LIMITS.applicableResults) return true;
    if (rows.length < AI_LIMITS.applicableResults) return false;
    after = rows.at(-1)!.id;
  }
}
