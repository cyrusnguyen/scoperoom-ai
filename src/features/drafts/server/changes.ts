import { keyPattern, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { recordEvents, requestHash } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseChanges, parseChangesResult, type Changes, type ChangesResult } from "../contracts/changes.ts";
import { applyChanges, type AppliedChanges } from "../domain/changes.ts";
import { asJson, auditRefs, draftMutation, graphFailure, nextRevision, requireStoredSize } from "./execute-command.ts";

// POST D/changes: the whole unsaved batch in one transaction under the project lock, with one PROJECT receipt.
const CHANGES_OPERATION = "DRAFT_CHANGES_V1";
/**
 * The largest batch (100 commands, 200 moves) on a 1.93 MB draft measured 0.86–1.72 s end to end locally, about the
 * same as one single command on that draft (0.84–1.15 s): the cost is reading, size-checking and writing 2 MB of JSONB,
 * not the batch. Prisma's 5 s default leaves too little room for waiting on the project lock behind another save and for
 * a slower hosted database; 15 s does, while still bounding how long a stuck save can hold the lock.
 */
const CHANGES_TIMEOUT_MS = 15_000;

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
    // The same audit as the single-command and position routes, written in one statement: one event per effective command
    // and one per moved flow. Every event carries the batch's single saved layoutRevision.
    const eventSequence = await recordEvents(tx, project, actorId, [
      ...applied.saved.map((saved) => ({ action: "DRAFT_COMMAND_SAVED", entityRefs: auditRefs(saved.applied, saved.entityRef ? [saved.entityRef] : []), metadata: { command: saved.command, documentRevision: saved.documentRevision, layoutRevision } })),
      ...applied.moved.map((group) => ({
        action: "DRAFT_POSITIONS_SAVED", entityRefs: [group.flowId, ...Object.keys(group.positions)].slice(0, 25).map((id) => ({ kind: "DRAFT_ENTITY", id })),
        metadata: { mode: "MOVE_NODES", layoutRevision, moved: Object.keys(group.positions).length },
      })),
    ]);
    return { draftId: draft.id, documentRevision, layoutRevision, eventSequence: Number(eventSequence), createdIds, versions, positions };
  }, CHANGES_TIMEOUT_MS);
}
