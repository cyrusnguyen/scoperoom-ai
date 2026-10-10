import { type ReviewRequest } from "../../../../prisma/generated/client.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { readAsMember } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { canonicalJson } from "../../proposals/domain/capture.ts";
import { storedDraft } from "../../drafts/server/execute-command.ts";
import { REVIEW_STATES, reviewCounter, type ReviewDetail, type ReviewPage, type ReviewState, type ReviewSummary } from "../contracts/review.ts";
import { storedSnapshot, loadSnapshot } from "./snapshot.ts";
const summary = (row: ReviewRequest, reviewHash: string): ReviewSummary => ({
  reviewId: row.id, snapshotId: row.candidateSnapshotId, sourceDraftId: row.sourceDraftId, state: row.state, reviewVersion: row.version, reviewHash, createdAt: row.createdAt.toISOString(), createdBy: row.createdBy, lastEventSequence: reviewCounter(Number(row.lastEventSequence))
});
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
        }], take: 51, include: {
        candidate: true
      }
    });
    const items = rows.slice(0, 50).map(row => summary(row, storedSnapshot(row.candidate).reviewHash));
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
      }
    });
    if (!review) {
      throw new ProjectError("NOT_FOUND");
    }
    const snapshot = await loadSnapshot(tx, projectId, review.candidateSnapshotId);
    if (review.sourceDraftId !== snapshot.sourceDraftId || review.parentSnapshotId !== snapshot.parentSnapshotId || review.designatedApproverId !== snapshot.policySnapshot.designatedApproverId || review.approvalPolicyVersion !== snapshot.policySnapshot.approvalPolicyVersion || review.createdBy !== snapshot.createdBy || review.createdAt.toISOString() !== snapshot.createdAt) {
      throw new ProjectError("UNAVAILABLE");
    }
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
      }, snapshot, decision: null, draftChanges: {
        replaced: current.id !== snapshot.sourceDraftId, contentChanged: canonicalJson(pair.document) !== canonicalJson(snapshot.documentJson), layoutChanged: canonicalJson(pair.layout) !== canonicalJson(snapshot.layoutJson)
      }
    };
  });
}
