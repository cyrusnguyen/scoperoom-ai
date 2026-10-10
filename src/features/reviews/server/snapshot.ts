import { canonicalJson, sha256 } from "../../proposals/domain/capture.ts";
import { CANDIDATE_BYTES, parseCandidatePayload, reviewHashValue, type CandidatePayload, type CandidateSnapshot } from "../contracts/review.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import type { Transaction } from "../../projects/server/access.ts";
import type { ScopeSnapshot } from "../../../../prisma/generated/client.ts";
export function candidateHashes(payload: CandidatePayload) {
  const parsed = parseCandidatePayload(payload);
  return {
    contentHash: sha256(canonicalJson({
      canonicalizationVersion: 1, schemaVersion: 3, documentJson: parsed.documentJson, evidenceManifest: parsed.evidenceManifest
    })), reviewHash: sha256(canonicalJson(parsed))
  };
}
export async function requireCandidateSize(tx: Transaction, snapshot: CandidateSnapshot) {
  const canonical = canonicalJson(snapshot);
  if (Buffer.byteLength(canonical, "utf8") > CANDIDATE_BYTES) {
    throw new ProjectError("LIMIT_EXCEEDED");
  }
  const [size] = await tx.$queryRaw<{
    bytes: number;
  }[]>`SELECT octet_length(${canonical}::jsonb::text)::integer AS bytes`;
  if (!size || size.bytes > CANDIDATE_BYTES) {
    throw new ProjectError("LIMIT_EXCEEDED");
  }
}
export function storedSnapshot(row: ScopeSnapshot): CandidateSnapshot {
  try {
    const payload = parseCandidatePayload(row.payload);
    const hashes = candidateHashes(payload);
    if (payload.projectId !== row.projectId || payload.sourceDraftId !== row.sourceDraftId || payload.parentSnapshotId !== row.parentSnapshotId
      || payload.capturedDocumentRevision !== row.capturedDocumentRevision || payload.capturedLayoutRevision !== row.capturedLayoutRevision
      || payload.policySnapshot.designatedApproverId !== row.designatedApproverId || payload.policySnapshot.approvalPolicyVersion !== row.approvalPolicyVersion
      || hashes.contentHash !== reviewHashValue(row.contentHash) || hashes.reviewHash !== reviewHashValue(row.reviewHash)
      || payload.evidenceManifest.some(source => sha256(source.text) !== source.contentHash)) {
      throw new Error("CORRUPT");
    }
    const snapshot = {
      ...payload, id: row.id, ...hashes, createdBy: row.createdBy, createdAt: row.createdAt.toISOString()
    };
    if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > CANDIDATE_BYTES) {
      throw new Error("CORRUPT");
    }
    return snapshot;
  }
  catch {
    throw new ProjectError("UNAVAILABLE");
  }
}
export async function loadSnapshot(tx: Transaction, projectId: string, snapshotId: string) {
  const row = await tx.scopeSnapshot.findFirst({
    where: {
      id: snapshotId, projectId
    }
  });
  if (!row) {
    throw new ProjectError("UNAVAILABLE");
  }
  return storedSnapshot(row);
}
