import { keyPattern, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { recordEvent, requestHash } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseChanges, parseChangesResult, type Changes, type ChangesResult } from "../contracts/changes.ts";
import { applyChanges, type AppliedChanges } from "../domain/changes.ts";
import { asJson, auditRefs, draftMutation, graphFailure, nextRevision, requireStoredSize } from "./execute-command.ts";

// POST D/changes: the whole unsaved batch in one transaction under the project lock, with one PROJECT receipt.
const CHANGES_OPERATION = "DRAFT_CHANGES_V1";

export async function saveChanges(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<ChangesResult> {
  const { key, ...raw } = input;
  let changes: Changes;
  try {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("INVALID_INPUT");
    changes = parseChanges(raw);
  } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(CHANGES_OPERATION, { projectId, draftId, changes });
  return draftMutation(identity, projectId, draftId, key, CHANGES_OPERATION, hash, parseChangesResult, async (tx, project, draft, actorId) => {
    let applied: AppliedChanges;
    try { applied = applyChanges(draft.draft, draft.documentRevision, changes); } catch (error) { graphFailure(error); }
    const { documentRevision, createdIds, versions, positions } = applied;
    // An effective no-op keeps every counter; only its receipt is saved.
    if (!applied.saved.length && !applied.moved.length) {
      return { draftId: draft.id, documentRevision, layoutRevision: draft.layoutRevision, eventSequence: Number(project.eventSequence), createdIds, versions, positions };
    }
    const layoutRevision = applied.layoutChanged ? nextRevision(draft.layoutRevision) : draft.layoutRevision;
    await requireStoredSize(tx, applied.document, applied.layout);
    await tx.scopeDraft.update({ where: { id: draft.id }, data: { documentJson: asJson(applied.document), layoutJson: asJson(applied.layout), documentRevision, layoutRevision }, select: { id: true } });
    // The same audit as the single-command and position routes: one event per effective command, one per moved flow.
    // Every event carries the batch's single saved layoutRevision.
    let eventSequence = project.eventSequence;
    for (const saved of applied.saved) {
      eventSequence = await recordEvent(tx, { id: project.id, eventSequence }, actorId, "DRAFT_COMMAND_SAVED", auditRefs(saved.applied),
        { command: saved.command, documentRevision: saved.documentRevision, layoutRevision });
    }
    for (const group of applied.moved) {
      const refs = [group.flowId, ...Object.keys(group.positions)].slice(0, 25).map((id) => ({ kind: "DRAFT_ENTITY", id }));
      eventSequence = await recordEvent(tx, { id: project.id, eventSequence }, actorId, "DRAFT_POSITIONS_SAVED", refs,
        { mode: "MOVE_NODES", layoutRevision, moved: Object.keys(group.positions).length });
    }
    return { draftId: draft.id, documentRevision, layoutRevision, eventSequence: Number(eventSequence), createdIds, versions, positions };
  });
}
