import type { DraftView } from "../../drafts/contracts/scope-document.ts";
import type { Buffers } from "./buffers.ts";

// The Studio's slice of the shell's per-project UI store (UI00 "Per-project UI state"). Memory only: none of it is
// written to browser storage, and a project switch keeps it until the project is dropped or its edits discarded.
export type Selection = { kind: "NODES"; ids: string[] } | { kind: "EDGE"; id: string } | { kind: "FLOW"; id: string } | null;
export type StudioView = "canvas" | "list";
export type StudioUi = { buffers: Buffers; flowId: string | null; selection: Selection; view: StudioView | null };
export const defaultStudioUi: StudioUi = { buffers: {}, flowId: null, selection: null, view: null };
export type SelectChange = { id: string; selected: boolean };

/** Folds React Flow node select/unselect changes into the selection. Edge or flow selections survive unselect-only batches. */
export function selectNodes(selection: Selection, changes: SelectChange[]): Selection {
  if (selection?.kind !== "NODES" && !changes.some((change) => change.selected)) return selection;
  const ids = new Set(selection?.kind === "NODES" ? selection.ids : []);
  for (const change of changes) {
    if (change.selected) ids.add(change.id);
    else ids.delete(change.id);
  }
  return ids.size ? { kind: "NODES", ids: [...ids] } : null;
}

/** Folds React Flow edge select/unselect changes into the selection (one edge at a time). */
export function selectEdge(selection: Selection, changes: SelectChange[]): Selection {
  const picked = changes.find((change) => change.selected);
  if (picked) return { kind: "EDGE", id: picked.id };
  if (selection?.kind === "EDGE" && changes.some((change) => change.id === selection.id)) return null;
  return selection;
}

/** Adds or removes one node from a multi-selection (List checkboxes). */
export function toggleNode(selection: Selection, id: string): Selection {
  return selectNodes(selection, [{ id, selected: !(selection?.kind === "NODES" && selection.ids.includes(id)) }]);
}

/** A later read of the same draft: neither revision went backwards. Late responses fail this and are dropped. */
export function isNewer(candidate: DraftView, current: DraftView): boolean {
  return candidate.id === current.id && candidate.documentRevision >= current.documentRevision && candidate.layoutRevision >= current.layoutRevision;
}
