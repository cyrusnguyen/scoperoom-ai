import { createHash } from "node:crypto";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { profileFor, readProject, recordEvent, requestHash, requireActive, requireMember, withDatabase, withReadSnapshot } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import {
  parseArrangementRequest, parsePositionCommand, parsePositionResult, type ArrangementPreview, type ArrangementRequest, type PositionCommand, type PositionResult,
} from "../contracts/positions.ts";
import { GraphError } from "../domain/graph.ts";
import { ALGORITHM_VERSION, applyArrangement, arrange, arrangementCanonical, moveNodes, type Placed } from "./layout.ts";
import { asJson, draftMutation, graphFailure, nextRevision, storedDraft } from "./execute-command.ts";

// Final position saves and whole-flow arrangement (Data03 "Final position save"; API "POST D/positions", "D/arrangement-preview").
const POSITIONS_OPERATION = "DRAFT_POSITIONS_V1";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** POST D/positions: MOVE_NODES or ARRANGE_FLOW. Layout and position versions only; the document never changes. */
export async function savePositions(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<PositionResult> {
  const { key, ...raw } = input;
  let command: PositionCommand;
  try {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("INVALID_INPUT");
    command = parsePositionCommand(raw);
  } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(POSITIONS_OPERATION, { projectId, draftId, command });
  return draftMutation(identity, projectId, draftId, key, POSITIONS_OPERATION, hash, parsePositionResult, async (tx, project, draft, actorId) => {
    let placed: Placed;
    try {
      if (command.mode === "MOVE_NODES") placed = moveNodes(draft.draft, command);
      else {
        // An arrangement is accepted only for the exact saved pair and algorithm it was previewed against, recomputed here.
        if (command.expectedDocumentRevision !== draft.documentRevision) throw new GraphError("STALE_DOCUMENT_REVISION", { documentRevision: draft.documentRevision });
        if (command.expectedLayoutRevision !== draft.layoutRevision) throw new GraphError("STALE_LAYOUT_REVISION", { layoutRevision: draft.layoutRevision });
        if (!draft.draft.document.flows[command.flowId]) throw new GraphError("INVALID_INPUT");
        const positions = arrange(draft.draft.document, command.flowId, command.direction);
        const context = { projectId: project.id, draftId: draft.id, flowId: command.flowId, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, direction: command.direction };
        if (command.algorithmVersion !== ALGORITHM_VERSION || sha256(arrangementCanonical(context, positions)) !== command.arrangementHash) throw new GraphError("ARRANGEMENT_PREVIEW_CHANGED");
        placed = applyArrangement(draft.draft, command.flowId, command.direction, positions);
      }
    } catch (error) { graphFailure(error); }
    // An effective no-op keeps every counter; only its receipt is saved.
    if (!placed.changed) return { draftId: draft.id, layoutRevision: draft.layoutRevision, eventSequence: Number(project.eventSequence), positions: {} };
    const layoutRevision = nextRevision(draft.layoutRevision);
    await tx.scopeDraft.update({ where: { id: draft.id }, data: { layoutJson: asJson(placed.layout), layoutRevision }, select: { id: true } });
    const refs = [command.flowId, ...Object.keys(placed.positions)].slice(0, 25).map((id) => ({ kind: "DRAFT_ENTITY", id }));
    const sequence = await recordEvent(tx, project, actorId, "DRAFT_POSITIONS_SAVED", refs, { mode: command.mode, layoutRevision, moved: Object.keys(placed.positions).length });
    return { draftId: draft.id, layoutRevision, eventSequence: Number(sequence), positions: placed.positions };
  });
}

/** POST D/arrangement-preview: nonmutating, for the current authors of an ACTIVE project's current draft. */
export async function previewArrangement(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<ArrangementPreview> {
  if (!uuid.test(projectId) || !uuid.test(draftId)) throw new ProjectError("NOT_FOUND");
  let request: ArrangementRequest;
  try { request = parseArrangementRequest(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      const role = requireMember(project);
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      const row = await tx.scopeDraft.findFirst({ where: { id: draftId, projectId: project.id }, select: { id: true, status: true, documentRevision: true, layoutRevision: true, documentJson: true, layoutJson: true } });
      if (!row) throw new ProjectError("NOT_FOUND");
      if (row.status !== "EDITABLE" || row.id !== project.currentDraftId) throw new ProjectError("DRAFT_REPLACED");
      if (row.documentRevision !== request.expectedDocumentRevision) throw new ProjectError("STALE_DOCUMENT_REVISION", { documentRevision: row.documentRevision });
      if (row.layoutRevision !== request.expectedLayoutRevision) throw new ProjectError("STALE_LAYOUT_REVISION", { layoutRevision: row.layoutRevision });
      const draft = storedDraft(row.documentJson, row.layoutJson);
      if (!draft.document.flows[request.flowId]) throw new ProjectError("INVALID_INPUT");
      const positions = arrange(draft.document, request.flowId, request.direction);
      const context = { projectId: project.id, draftId: row.id, flowId: request.flowId, documentRevision: row.documentRevision, layoutRevision: row.layoutRevision, direction: request.direction };
      return {
        flowId: request.flowId, documentRevision: row.documentRevision, layoutRevision: row.layoutRevision, direction: request.direction,
        algorithmVersion: ALGORITHM_VERSION, positions, arrangementHash: sha256(arrangementCanonical(context, positions)),
      };
    });
  });
}
