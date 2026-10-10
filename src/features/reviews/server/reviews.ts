import { randomUUID } from "node:crypto";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { checkReceipt, findReceipt, lockActor, lockProject, profileFor, projectRole, readAsMember, recordEvent, requestHash, requireActive, requireMember, saveReceipt, withDatabase, type ProjectRow, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { asJson, draftMutation, nextRevision, storedDraft, type LockedDraft } from "../../drafts/server/execute-command.ts";
import { citationMatches, lineStarts, type SourceVersionView } from "../../sources/contracts/source-version.ts";
import { parseFreezeInput, parseFreezeResult, parseWithdrawInput, parseWithdrawResult, type CandidatePayload, type FreezeInput, type ReviewPreview } from "../contracts/review.ts";
import { checkCandidate } from "../domain/candidate.ts";
import { candidateHashes, loadSnapshot, requireCandidateSize } from "./snapshot.ts";
/** One scoped immutable-version query for all references, including background graph content. */
async function captureEvidence(tx: Transaction, projectId: string, document: CandidatePayload["documentJson"]): Promise<SourceVersionView[]> {
  const refs = [...Object.values(document.requirements), ...Object.values(document.nodes), ...Object.values(document.edges)].flatMap(record => record.sourceRefs);
  const ids = [...new Set(refs.map(ref => ref.sourceVersionId))];
  if (!ids.length) {
    return [];
  }
  const rows = await tx.$queryRaw<Array<{
    id: string;
    source_id: string;
    kind: string;
    sequence: number;
    title: string;
    text: string;
    content_hash: string;
    code_point_count: number;
    utf8_byte_count: number;
    origin: unknown;
    created_by: string;
    created_at: Date;
  }>>`
  SELECT v.id,v.source_id,s.kind::text AS kind,v.sequence,v.title,v.text,v.content_hash,v.code_point_count,v.utf8_byte_count,v.origin,v.created_by,v.created_at
  FROM app.source_version v JOIN app.source_document s ON s.project_id=v.project_id AND s.id=v.source_id
  WHERE v.project_id=${projectId}::uuid AND v.id=ANY(${ids}::uuid[]) ORDER BY v.id`;
  const texts = new Map(rows.map(row => [row.id, row.text]));
  if (refs.some(ref => !texts.has(ref.sourceVersionId) || !citationMatches(texts.get(ref.sourceVersionId)!, ref))) {
    throw new ProjectError("INVALID_SOURCE_REFERENCE");
  }
  return rows.map(row => ({
    id: row.id, sourceId: row.source_id, kind: row.kind, sequence: row.sequence, title: row.title, text: row.text, contentHash: row.content_hash, codePointCount: row.code_point_count, utf8ByteCount: row.utf8_byte_count, lineStarts: lineStarts(row.text), origin: row.origin, createdBy: row.created_by, createdAt: row.created_at.toISOString()
  }));
}
function guards(project: ProjectRow, draft: LockedDraft): FreezeInput {
  return {
    expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, expectedParentSnapshotId: project.approvedSnapshotId, expectedApprovalPolicyVersion: project.approvalPolicyVersion
  };
}
function compareGuards(project: ProjectRow, draft: LockedDraft, input: FreezeInput) {
  if (draft.documentRevision !== input.expectedDocumentRevision) {
    throw new ProjectError("STALE_DOCUMENT_REVISION");
  }
  if (draft.layoutRevision !== input.expectedLayoutRevision) {
    throw new ProjectError("STALE_LAYOUT_REVISION");
  }
  if (project.approvedSnapshotId !== input.expectedParentSnapshotId) {
    throw new ProjectError("BASELINE_CHANGED");
  }
  if (project.approvalPolicyVersion !== input.expectedApprovalPolicyVersion) {
    throw new ProjectError("REVIEW_POLICY_CHANGED");
  }
}
async function capture(tx: Transaction, project: ProjectRow, draft: LockedDraft, input: FreezeInput) {
  compareGuards(project, draft, input);
  if (!project.designatedApproverId || !["OWNER", "EDITOR", "REVIEWER"].includes(await projectRole(tx, project, project.designatedApproverId) ?? "")) {
    throw new ProjectError("REVIEW_POLICY_CHANGED", {
      reason: "Choose an eligible designated approver in Sharing."
    });
  }
  const evidence = await captureEvidence(tx, project.id, draft.draft.document);
  const baseline = project.approvedSnapshotId ? (await loadSnapshot(tx, project.id, project.approvedSnapshotId)).documentJson : null;
  const check = checkCandidate({
    draft: {
      id: draft.id, status: "EDITABLE", documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, ...draft.draft
    }, evidence, baseline
  });
  const payload: CandidatePayload = {
    canonicalizationVersion: 1, schemaVersion: 3, projectId: project.id, projectName: project.name, sourceDraftId: draft.id, capturedDocumentRevision: draft.documentRevision, capturedLayoutRevision: draft.layoutRevision, documentJson: draft.draft.document, layoutJson: draft.draft.layout, evidenceManifest: evidence, policySnapshot: {
      designatedApproverId: project.designatedApproverId, approvalPolicyVersion: project.approvalPolicyVersion
    }, parentSnapshotId: project.approvedSnapshotId, agreementIntent: "INCLUDED_SCOPE", requestResolution: null
  };
  return {
    payload, check
  };
}
function parseInput(input: unknown) {
  try {
    return parseFreezeInput(input);
  }
  catch {
    throw new ProjectError("INVALID_INPUT");
  }
}
export async function previewReview(identity: ProjectIdentity, projectId: string, draftId: string, input: unknown): Promise<ReviewPreview> {
  const parsed = parseInput(input);
  if (!uuid.test(draftId)) {
    throw new ProjectError("NOT_FOUND");
  }
  return readAsMember(identity, projectId, async (tx, project, profileId) => {
    requireActive(project);
    const row = await tx.scopeDraft.findFirst({
      where: {
        id: draftId, projectId
      }
    });
    if (!row) {
      throw new ProjectError("NOT_FOUND");
    }
    if (row.status !== "EDITABLE" || project.currentDraftId !== row.id) {
      throw new ProjectError("DRAFT_REPLACED");
    }
    const draft = {
      id: row.id, documentRevision: row.documentRevision, layoutRevision: row.layoutRevision, draft: storedDraft(row.documentJson, row.layoutJson)
    };
    const { payload, check } = await capture(tx, project, draft, parsed);
    await requireCandidateSize(tx, {
      ...payload, id: project.id, ...candidateHashes(payload), createdBy: profileId, createdAt: new Date().toISOString()
    });
    const open = await tx.reviewRequest.findFirst({
      where: {
        projectId, state: "OPEN"
      }, select: {
        id: true
      }
    });
    return {
      draftId: draft.id, guards: guards(project, draft), check, policySnapshot: payload.policySnapshot, openReviewId: open?.id ?? null, reviewsRevision: project.reviewsRevision
    };
  });
}
export async function freezeReview(identity: ProjectIdentity, projectId: string, draftId: string, input: unknown, key: string) {
  const parsed = parseInput(input);
  if (typeof key !== "string" || !keyPattern.test(key)) {
    throw new ProjectError("INVALID_INPUT");
  }
  const operation = "FREEZE_REVIEW_V1", hash = requestHash(operation, {
    projectId, draftId, input: parsed
  });
  const result = await draftMutation(identity, projectId, draftId, key, operation, hash, parseFreezeResult, async (tx, project, draft, actorId) => {
    const { payload, check } = await capture(tx, project, draft, parsed);
    if (await tx.reviewRequest.count({
      where: {
        projectId, state: "OPEN"
      }
    })) {
      throw new ProjectError("ACTIVE_REVIEW_EXISTS");
    }
    if (!check.valid) {
      throw new ProjectError("CANDIDATE_INVALID", {
        errors: JSON.stringify(check.errors), truncated: check.truncated
      });
    }
    const snapshotId = randomUUID(), reviewId = randomUUID(), createdAt = new Date(), hashes = candidateHashes(payload);
    await requireCandidateSize(tx, {
      ...payload, id: snapshotId, ...hashes, createdBy: actorId, createdAt: createdAt.toISOString()
    });
    await tx.scopeSnapshot.create({
      data: {
        id: snapshotId, projectId, sourceDraftId: draftId, parentSnapshotId: payload.parentSnapshotId, capturedDocumentRevision: draft.documentRevision, capturedLayoutRevision: draft.layoutRevision, designatedApproverId: payload.policySnapshot.designatedApproverId, approvalPolicyVersion: project.approvalPolicyVersion, payload: asJson(payload), ...hashes, createdBy: actorId, createdAt
      }
    });
    const sequence = await recordEvent(tx, project, actorId, "REVIEW_FROZEN", [{
        kind: "REVIEW", id: reviewId
      }, {
        kind: "SNAPSHOT", id: snapshotId
      }], {
      documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision
    });
    await tx.reviewRequest.create({
      data: {
        id: reviewId, projectId, candidateSnapshotId: snapshotId, sourceDraftId: draftId, parentSnapshotId: payload.parentSnapshotId, designatedApproverId: payload.policySnapshot.designatedApproverId, approvalPolicyVersion: project.approvalPolicyVersion, createdBy: actorId, createdAt, lastEventSequence: sequence
      }
    });
    await tx.project.update({
      where: {
        id: projectId
      }, data: {
        reviewsRevision: sequence
      }
    });
    return {
      reviewId, snapshotId, reviewVersion: 1, reviewHash: hashes.reviewHash, draftId: draft.id, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, eventSequence: Number(sequence)
    };
  });
  await readAsMember(identity, projectId, async (tx) => {
    const row = await tx.reviewRequest.findFirst({
      where: {
        id: result.reviewId, projectId, candidateSnapshotId: result.snapshotId, sourceDraftId: draftId
      }, include: {
        candidate: true
      }
    });
    if (!row || row.candidate.reviewHash !== result.reviewHash || row.candidate.capturedDocumentRevision !== result.documentRevision || row.candidate.capturedLayoutRevision !== result.layoutRevision || result.draftId !== draftId.toLowerCase()) {
      throw new ProjectError("UNAVAILABLE");
    }
  });
  return result;
}
export async function withdrawReview(identity: ProjectIdentity, projectId: string, reviewId: string, input: unknown, key: string) {
  let parsed;
  try {
    parsed = parseWithdrawInput(input);
    if (typeof key !== "string" || !keyPattern.test(key)) {
      throw new Error();
    }
  }
  catch {
    throw new ProjectError("INVALID_INPUT");
  }
  if (!uuid.test(projectId) || !uuid.test(reviewId)) {
    throw new ProjectError("NOT_FOUND");
  }
  const operation = "WITHDRAW_REVIEW_V1", hash = requestHash(operation, {
    projectId, reviewId, input: parsed
  });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const review = await tx.reviewRequest.findFirst({
        where: {
          id: reviewId, projectId
        }
      });
      if (!review) {
        throw new ProjectError("NOT_FOUND");
      }
      const receipt = await findReceipt(tx, profile.id, "PROJECT", projectId, key);
      if (receipt) {
        checkReceipt(receipt, operation, hash);
        const value = parseWithdrawResult(receipt.result);
        if (value.reviewId !== review.id) {
          throw new ProjectError("UNAVAILABLE");
        }
        return {
          ...value, replayed: true
        };
      }
      if (role !== "OWNER" && role !== "EDITOR") {
        throw new ProjectError("FORBIDDEN");
      }
      requireActive(project);
      await tx.$queryRaw `SELECT id FROM app.scope_draft WHERE project_id=${projectId}::uuid AND id=${review.sourceDraftId}::uuid FOR UPDATE`;
      await tx.$queryRaw `SELECT id FROM app.review_request WHERE project_id=${projectId}::uuid AND id=${reviewId}::uuid FOR UPDATE`;
      if (review.state !== "OPEN" || review.version !== parsed.expectedReviewVersion) {
        throw new ProjectError("CONFLICT");
      }
      const reviewVersion = nextRevision(review.version), sequence = await recordEvent(tx, project, profile.id, "REVIEW_WITHDRAWN", [{
          kind: "REVIEW", id: reviewId
        }], {
        reviewVersion
      });
      await tx.reviewRequest.update({
        where: {
          id: reviewId
        }, data: {
          state: "WITHDRAWN", version: reviewVersion, closedReason: parsed.reason, lastEventSequence: sequence, updatedAt: new Date()
        }
      });
      await tx.project.update({
        where: {
          id: projectId
        }, data: {
          reviewsRevision: sequence
        }
      });
      const value = {
        reviewId: review.id, reviewVersion, state: "WITHDRAWN" as const, eventSequence: Number(sequence)
      };
      await saveReceipt(tx, profile.id, "PROJECT", projectId, key, operation, hash, value);
      return {
        ...value, replayed: false
      };
    });
  });
}
