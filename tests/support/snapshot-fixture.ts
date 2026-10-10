import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { storedDraft } from "../../src/features/drafts/server/execute-command.ts";
import { candidateHashes } from "../../src/features/reviews/server/snapshot.ts";
import type { CandidatePayload } from "../../src/features/reviews/contracts/review.ts";
/** Real immutable same-project baseline fixture; publication is deliberately outside this test's scope. */
export async function seedSnapshot(database: Client, projectId: string): Promise<string> {
  const { rows: [row] } = await database.query<{
    name: string;
    owner_id: string;
    approval_policy_version: number;
    draft_id: string;
    document_revision: number;
    layout_revision: number;
    document_json: unknown;
    layout_json: unknown;
  }>(`
  select p.name,p.owner_id,p.approval_policy_version,d.id draft_id,d.document_revision,d.layout_revision,d.document_json,d.layout_json
  from app.project p join app.scope_draft d on d.project_id=p.id and d.id=p.current_draft_id where p.id=$1`, [projectId]);
  if (!row) {
    throw new Error("Missing snapshot fixture project.");
  }
  const pair = storedDraft(row.document_json, row.layout_json);
  const payload: CandidatePayload = {
    canonicalizationVersion: 1, schemaVersion: 3, projectId, projectName: row.name, sourceDraftId: row.draft_id, capturedDocumentRevision: row.document_revision, capturedLayoutRevision: row.layout_revision, documentJson: pair.document, layoutJson: pair.layout, evidenceManifest: [], policySnapshot: {
      designatedApproverId: row.owner_id, approvalPolicyVersion: row.approval_policy_version
    }, parentSnapshotId: null, agreementIntent: "INCLUDED_SCOPE", requestResolution: null
  };
  const id = randomUUID(), hashes = candidateHashes(payload);
  await database.query(`insert into app.scope_snapshot(id,project_id,source_draft_id,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,payload,content_hash,review_hash,created_by,created_at)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,current_timestamp)`, [id, projectId, row.draft_id, row.document_revision, row.layout_revision, row.owner_id, row.approval_policy_version, payload, hashes.contentHash, hashes.reviewHash]);
  return id;
}
