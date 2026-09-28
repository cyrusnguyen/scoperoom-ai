import type { Changes } from "../contracts/changes.ts";
import type { SavedPosition } from "../contracts/draft-layout.ts";
import { applyGraphCommand, bump, GraphError, type Applied, type Draft } from "./graph.ts";
import { moveNodes } from "./layout.ts";

// A batch of draft changes (API "POST D/changes"): commands in order, then moves, all or nothing. Each command is checked
// by its own guard against the state the earlier items produced, and documentRevision advances once per effective
// command, exactly as the same commands sent one by one would. A refusal names its item: `part` and `index`.
export type AppliedChanges = Draft & {
  documentRevision: number;
  layoutChanged: boolean;
  createdIds: string[];
  versions: Record<string, number>;
  positions: Record<string, SavedPosition>;
  /** Effective commands, each with the documentRevision it produced. No-ops are left out. */
  saved: Array<{ command: string; documentRevision: number; applied: Applied }>;
  /** Move groups that moved at least one step. */
  moved: Array<{ flowId: string; positions: Record<string, SavedPosition> }>;
};

function at(part: "commands" | "moves", index: number, error: unknown): never {
  if (error instanceof GraphError) throw new GraphError(error.code, { ...error.details, part, index });
  throw error;
}

export function applyChanges(base: Draft, documentRevision: number, changes: Changes): AppliedChanges {
  const used = new Set([
    ...Object.keys(base.document.flows), ...Object.keys(base.document.nodes), ...Object.keys(base.document.edges), ...base.document.retiredEntityIds,
  ]);
  let draft: Draft = { document: base.document, layout: base.layout };
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
      const applied = applyGraphCommand(draft, revision, command, newId);
      if (next !== proposedIds.length) throw new GraphError("INVALID_INPUT");
      if (!applied.documentChanged) continue;
      revision = bump(revision);
      draft = { document: applied.document, layout: applied.layout };
      layoutChanged ||= applied.layoutChanged;
      createdIds.push(...applied.createdIds);
      Object.assign(versions, applied.versions);
      saved.push({ command: command.command, documentRevision: revision, applied });
    } catch (error) { at("commands", index, error); }
  }
  for (const [index, group] of changes.moves.entries()) {
    try {
      const placed = moveNodes(draft, { mode: "MOVE_NODES", ...group });
      if (!placed.changed) continue;
      draft = { document: draft.document, layout: placed.layout };
      layoutChanged = true;
      Object.assign(positions, placed.positions);
      moved.push({ flowId: group.flowId, positions: placed.positions });
    } catch (error) { at("moves", index, error); }
  }
  // Versions report only records that still exist, at their final version.
  const live = { ...draft.document.flows, ...draft.document.nodes, ...draft.document.edges };
  const finalVersions = Object.fromEntries(Object.keys(versions).filter((key) => live[key]).map((key) => [key, live[key]!.version]));
  return { ...draft, documentRevision: revision, layoutChanged, createdIds, versions: finalVersions, positions, saved, moved };
}
