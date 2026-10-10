import { nextRevision } from "../../drafts/server/execute-command.ts";
import { recordEvent, type ProjectRow, type Transaction } from "../../projects/server/access.ts";
/** Caller owns the project lock. Source draft precedes review even for automatic policy/lifecycle closure. */
export async function invalidateOpenReview(tx: Transaction, project: ProjectRow, actorId: string, reason: string) {
  const review = await tx.reviewRequest.findFirst({
    where: {
      projectId: project.id, state: "OPEN"
    }
  });
  if (!review) {
    return;
  }
  await tx.$queryRaw `SELECT id FROM app.scope_draft WHERE project_id=${project.id}::uuid AND id=${review.sourceDraftId}::uuid FOR UPDATE`;
  await tx.$queryRaw `SELECT id FROM app.review_request WHERE project_id=${project.id}::uuid AND id=${review.id}::uuid FOR UPDATE`;
  const sequence = await recordEvent(tx, project, actorId, "REVIEW_SUPERSEDED", [{
      kind: "REVIEW", id: review.id
    }], {
    reason
  });
  await tx.reviewRequest.update({
    where: {
      id: review.id
    }, data: {
      state: "SUPERSEDED", version: nextRevision(review.version), closedReason: reason, lastEventSequence: sequence, updatedAt: new Date()
    }
  });
  await tx.project.update({
    where: {
      id: project.id
    }, data: {
      reviewsRevision: sequence
    }
  });
  project.eventSequence = sequence;
  project.reviewsRevision = Number(sequence);
}
