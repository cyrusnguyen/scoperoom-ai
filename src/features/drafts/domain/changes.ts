import type { Changes } from "../contracts/changes.ts";
import type { SavedPosition } from "../contracts/draft-layout.ts";
import { applyGraphCommand, bump, checkDraft, GraphError, usedIds, type Applied, type Draft } from "./graph.ts";
import { moveNodes } from "./moves.ts";

// A batch of draft changes (API "POST D/changes"): commands in order, then moves, all or nothing. Each command is checked
// by its own guard against the state the earlier items produced, and documentRevision advances once per effective
// command, exactly as the same commands sent one by one would. A refusal names its item: `part` and `index`.
// The batch works on one private copy changed in place and checks size and invariants once at the end, so a batch at
// the limits costs one clone and one validation, not one per command (about 45 ms each on a 2 MB document).
export type AppliedChanges = Draft & {
  documentRevision: number;
  layoutChanged: boolean;
  createdIds: string[];
  versions: Record<string, number>;
  positions: Record<string, SavedPosition>;
  /**
   * Effective commands, each with the documentRevision it produced. No-ops are left out. `entityRef` names a record
   * the command touched without creating, versioning or retiring it (a layout-only side-only RECONNECT_EDGE touches
   * only its edge) — for the audit row only, never fed back into the saved receipt.
   */
  saved: Array<{ command: string; documentRevision: number; applied: Applied; entityRef?: string }>;
  /** Move groups that moved at least one step. */
  moved: Array<{ flowId: string; positions: Record<string, SavedPosition> }>;
};

function at(part: "commands" | "moves", index: number, error: unknown): never {
  if (error instanceof GraphError) throw new GraphError(error.code, { ...error.details, part, index });
  throw error;
}

export function applyChanges(base: Draft, documentRevision: number, changes: Changes): AppliedChanges {
  const used = usedIds(base.document);
  let draft: Draft = { document: structuredClone(base.document), layout: structuredClone(base.layout) };
  let revision = documentRevision;
  let layoutChanged = false;
  const createdIds: string[] = [];
  const versions: Record<string, number> = {};
  const positions: Record<string, SavedPosition> = {};
  const saved: AppliedChanges["saved"] = [];
  const moved: AppliedChanges["moved"] = [];

  for (const [index, { command, proposedIds }] of changes.commands.entries()) {
    try {
      let next = 0;
      // Proposed ids are final: never an id the draft has used (retired included), never one the batch already took.
      const newId = () => {
        const value = proposedIds[next++];
        if (value === undefined || used.has(value)) throw new GraphError("INVALID_INPUT");
        used.add(value);
        return value;
      };
      const applied = applyGraphCommand(draft, revision, command, newId, { inPlace: true });
      if (next !== proposedIds.length) throw new GraphError("INVALID_INPUT");
      // A layout-only effect (Task 13's side-only RECONNECT_EDGE) still needs saving and its own audit event, just
      // never a documentRevision of its own.
      if (!applied.documentChanged && !applied.layoutChanged) continue;
      if (applied.documentChanged) revision = bump(revision);
      draft = { document: applied.document, layout: applied.layout };
      layoutChanged ||= applied.layoutChanged;
      createdIds.push(...applied.createdIds);
      Object.assign(versions, applied.versions);
      saved.push({ command: command.command, documentRevision: revision, applied, ...(command.command === "RECONNECT_EDGE" ? { entityRef: command.payload.edgeId } : {}) });
    } catch (error) { at("commands", index, error); }
  }
  for (const [index, group] of changes.moves.entries()) {
    try {
      const placed = moveNodes(draft, { mode: "MOVE_NODES", ...group }, { check: false });
      if (!placed.changed) continue;
      draft = { document: draft.document, layout: placed.layout };
      layoutChanged = true;
      Object.assign(positions, placed.positions);
      moved.push({ flowId: group.flowId, positions: placed.positions });
    } catch (error) { at("moves", index, error); }
  }
  // A final draft over its byte cap is a batch-level LIMIT_EXCEEDED, without an item index.
  if (layoutChanged || saved.length) checkDraft(draft);
  // Versions report only records that still exist, at their final version.
  const live = { ...draft.document.flows, ...draft.document.nodes, ...draft.document.edges };
  const finalVersions = Object.fromEntries(Object.keys(versions).filter((key) => live[key]).map((key) => [key, live[key]!.version]));
  return { ...draft, documentRevision: revision, layoutChanged, createdIds, versions: finalVersions, positions, saved, moved };
}
