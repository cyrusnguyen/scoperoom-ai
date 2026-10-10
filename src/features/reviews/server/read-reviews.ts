import { type ReviewDecision as DecisionRow, type ReviewRequest } from "../../../../prisma/generated/client.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { readAsMember } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { canonicalJson } from "../../proposals/domain/capture.ts";
import { storedDraft } from "../../drafts/server/execute-command.ts";
import { REVIEW_STATES, parseReviewDecision, reviewCounter, reviewHashValue, type CandidateSnapshot, type PublishedSnapshot, type SnapshotPage, type ReviewDetail, type ReviewPage, type ReviewState, type ReviewSummary } from "../contracts/review.ts";
import { loadSnapshot } from "./snapshot.ts";
type SummaryRow = Pick<ReviewRequest, "id" | "candidateSnapshotId" | "sourceDraftId" | "state" | "version" | "createdAt" | "createdBy" | "lastEventSequence">;
const summary = (row: SummaryRow, reviewHash: string): ReviewSummary => {
  try {
    return {
      reviewId: row.id, snapshotId: row.candidateSnapshotId, sourceDraftId: row.sourceDraftId, state: row.state, reviewVersion: row.version, reviewHash: reviewHashValue(reviewHash), createdAt: row.createdAt.toISOString(), createdBy: row.createdBy, lastEventSequence: reviewCounter(Number(row.lastEventSequence))
    };
  } catch {
    throw new ProjectError("UNAVAILABLE");
  }
};
export async function listReviews(identity: ProjectIdentity, projectId: string, options: {
  cursor?: string;
  state?: string;
} = {}): Promise<ReviewPage> {
  let cursor: {
    createdAt: Date;
    id: string;
  } | null = null;
  if (options.cursor !== undefined) {
    try {
      if (options.cursor.length > 256) {
        throw new Error();
      }
      const raw = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!raw || Object.keys(raw).sort().join(",") !== "createdAt,id" || !uuid.test(raw.id) || typeof raw.createdAt !== "string" || new Date(raw.createdAt).toISOString() !== raw.createdAt) {
        throw new Error();
      }
      cursor = {
        createdAt: new Date(raw.createdAt), id: raw.id
      };
    }
    catch {
      throw new ProjectError("INVALID_INPUT");
    }
  }
  if (options.state !== undefined && !REVIEW_STATES.includes(options.state as ReviewState)) {
    throw new ProjectError("INVALID_INPUT");
  }
  return readAsMember(identity, projectId, async (tx, project) => {
    const rows = await tx.reviewRequest.findMany({
      where: {
        projectId, ...(options.state ? {
          state: options.state as ReviewState
        } : {}), ...(cursor ? {
          OR: [{
              createdAt: {
                lt: cursor.createdAt
              }
            }, {
              createdAt: cursor.createdAt, id: {
                lt: cursor.id
              }
            }]
        } : {})
      }, orderBy: [{
          createdAt: "desc"
        }, {
          id: "desc"
        }], take: 51, select: {
        id: true, candidateSnapshotId: true, sourceDraftId: true, state: true, version: true, createdAt: true, createdBy: true, lastEventSequence: true,
        candidate: { select: { reviewHash: true } }
      }
    });
    const items = rows.slice(0, 50).map(row => summary(row, row.candidate.reviewHash));
    const last = items.at(-1);
    return {
      items, nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({
        createdAt: last.createdAt, id: last.reviewId
      })).toString("base64url") : null, reviewsRevision: project.reviewsRevision
    };
  });
}
export async function readReview(identity: ProjectIdentity, projectId: string, reviewId: string): Promise<ReviewDetail> {
  if (!uuid.test(reviewId)) {
    throw new ProjectError("NOT_FOUND");
  }
  return readAsMember(identity, projectId, async (tx, project) => {
    const review = await tx.reviewRequest.findFirst({
      where: {
        projectId, id: reviewId
      }, include: { decision: true }
    });
    if (!review) {
      throw new ProjectError("NOT_FOUND");
    }
    const snapshot = await loadSnapshot(tx, projectId, review.candidateSnapshotId);
    const decision = validatedDecision(review, snapshot);
    const current = project.currentDraftId ? await tx.scopeDraft.findFirst({
      where: {
        id: project.currentDraftId, projectId
      }
    }) : null;
    if (!current) {
      throw new ProjectError("UNAVAILABLE");
    }
    const pair = storedDraft(current.documentJson, current.layoutJson);
    return {
      review: {
        ...summary(review, snapshot.reviewHash), reason: review.closedReason, publicationSequence: review.publicationSequence === null ? null : reviewCounter(Number(review.publicationSequence)), publishedAt: review.publishedAt?.toISOString() ?? null
      }, snapshot, decision, draftChanges: {
        replaced: current.id !== snapshot.sourceDraftId, contentChanged: canonicalJson(pair.document) !== canonicalJson(snapshot.documentJson), layoutChanged: canonicalJson(pair.layout) !== canonicalJson(snapshot.layoutJson)
      }
    };
  });
}

/** Validate captured bindings and the exact terminal decision without consulting mutable draft/source/profile state. */
function validatedDecision(review: ReviewRequest & { decision: DecisionRow | null }, snapshot: CandidateSnapshot) {
  const rowDecision = review.decision;
  if (review.sourceDraftId !== snapshot.sourceDraftId || review.parentSnapshotId !== snapshot.parentSnapshotId || review.designatedApproverId !== snapshot.policySnapshot.designatedApproverId || review.approvalPolicyVersion !== snapshot.policySnapshot.approvalPolicyVersion || review.createdBy !== snapshot.createdBy || review.createdAt.toISOString() !== snapshot.createdAt) {
    throw new ProjectError("UNAVAILABLE");
  }
  let decision = null;
  try {
    decision = rowDecision ? parseReviewDecision({ ...rowDecision, createdAt: rowDecision.createdAt.toISOString() }) : null;
    const state = decision?.decision === "APPROVE" ? "APPROVED" : decision?.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REJECTED";
    if (decision ? decision.projectId !== snapshot.projectId || decision.reviewId !== review.id || decision.actorId !== snapshot.policySnapshot.designatedApproverId
      || decision.reviewedHash !== snapshot.reviewHash || state !== review.state || decision.comment !== review.closedReason
      : ["APPROVED", "CHANGES_REQUESTED", "REJECTED"].includes(review.state)) throw new Error();
  } catch { throw new ProjectError("UNAVAILABLE"); }

  if (review.state === "APPROVED" ? !review.publicationSequence || !review.publishedAt || review.publishedAt.toISOString() !== decision?.createdAt : review.publicationSequence !== null || review.publishedAt !== null) throw new ProjectError("UNAVAILABLE");
  return decision;
}

export async function listSnapshots(identity: ProjectIdentity, projectId: string, options: { cursor?: string } = {}): Promise<SnapshotPage> {
  let cursor: { projectId: string; id: string; publicationSequence: number } | null = null;
  if (options.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(options.cursor) || options.cursor.length > 256) throw new Error();
      const raw = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!raw || Object.keys(raw).sort().join(",") !== "id,projectId,publicationSequence" || !uuid.test(raw.id) || !uuid.test(raw.projectId)
        || raw.projectId !== projectId.toLowerCase() || !Number.isSafeInteger(raw.publicationSequence) || raw.publicationSequence < 1) throw new Error();
      cursor = raw;
    } catch { throw new ProjectError("INVALID_INPUT"); }
  }
  return readAsMember(identity, projectId, async (tx, project) => {
    const rows = await tx.reviewRequest.findMany({
      where: { projectId: project.id, state: "APPROVED", decision: { is: { decision: "APPROVE" } }, ...(cursor ? {
        OR: [{ publicationSequence: { lt: BigInt(cursor.publicationSequence) } }, { publicationSequence: BigInt(cursor.publicationSequence), candidateSnapshotId: { lt: cursor.id } }],
      } : {}) },
      orderBy: [{ publicationSequence: "desc" }, { candidateSnapshotId: "desc" }], take: 51,
      select: { id: true, candidateSnapshotId: true, publicationSequence: true, publishedAt: true,
        candidate: { select: { reviewHash: true, designatedApproverId: true } },
        decision: { select: { actorId: true, reviewedHash: true, createdAt: true } } },
    });
    const items = rows.slice(0, 50).map(row => {
      try {
        const publicationSequence = reviewCounter(Number(row.publicationSequence));
        if (!publicationSequence || !row.publishedAt || !row.decision || row.decision.actorId !== row.candidate.designatedApproverId
          || row.decision.reviewedHash !== row.candidate.reviewHash || row.publishedAt.toISOString() !== row.decision.createdAt.toISOString()) throw new Error();
        return { snapshotId: row.candidateSnapshotId, reviewId: row.id, publicationSequence, publishedAt: row.publishedAt.toISOString(), publishedBy: row.decision.actorId, reviewHash: reviewHashValue(row.candidate.reviewHash) };
      } catch { throw new ProjectError("UNAVAILABLE"); }
    });
    const last = items.at(-1);
    return { items, nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({ projectId: project.id, id: last.snapshotId, publicationSequence: last.publicationSequence })).toString("base64url") : null, baselineSequence: project.baselineSequence };
  });
}

export async function readSnapshot(identity: ProjectIdentity, projectId: string, snapshotId: string): Promise<PublishedSnapshot> {
  if (!uuid.test(snapshotId)) throw new ProjectError("NOT_FOUND");
  return readAsMember(identity, projectId, async (tx, project) => {
    const review = await tx.reviewRequest.findFirst({ where: { projectId: project.id, candidateSnapshotId: snapshotId, state: "APPROVED", decision: { is: { decision: "APPROVE" } } }, include: { decision: true } });
    if (!review) throw new ProjectError("NOT_FOUND");
    const snapshot = await loadSnapshot(tx, project.id, review.candidateSnapshotId);
    const decision = validatedDecision(review, snapshot);
    const publicationSequence = reviewCounter(Number(review.publicationSequence));
    if (!decision || !publicationSequence || !review.publishedAt) throw new ProjectError("UNAVAILABLE");
    return { snapshot, reviewId: review.id, publicationSequence, publishedAt: review.publishedAt.toISOString(), decision };
  });
}
