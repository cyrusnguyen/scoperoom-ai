import type { CommandResult, GraphCommand } from "../../drafts/contracts/commands.ts";
import type { DraftView } from "../../drafts/contracts/scope-document.ts";
import { dirtyFields, isDirty, type Buffers } from "./buffers.ts";

// The Studio's slice of the shell's per-project UI store (UI00 "Per-project UI state"). Memory only: none of it is
// written to browser storage, and a project switch keeps it until the project is dropped or its edits discarded.
export type Selection = { kind: "NODES"; ids: string[] } | { kind: "EDGE"; id: string } | { kind: "FLOW"; id: string } | null;
export type StudioView = "canvas" | "list";
type RevisionFloor = Pick<DraftView, "documentRevision" | "layoutRevision">;
export type SaveState = { state: "idle" | "saving" | "saved" | "failed"; message: string };
export type PendingCommand = { draftId: string; command: GraphCommand; key: string; inFlight: boolean };
// Endpoint buffers store document revisions in baseVersion and are sent only as RECONNECT_EDGE.
export type StudioUi = { acknowledgedRevisions: Record<string, RevisionFloor>; save: SaveState; refreshFailed: boolean; pending: PendingCommand | null; buffers: Buffers; endpointBuffers: Buffers; flowId: string | null; selection: Selection; view: StudioView | null };
export const defaultStudioUi: StudioUi = { acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, pending: null, buffers: {}, endpointBuffers: {}, flowId: null, selection: null, view: null };
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

/** Text edits and endpoint choices share leave-guard/status semantics, but use different commands. */
export function studioDirtyCount(ui: StudioUi): number {
  const buffers = [...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers)];
  const fields = buffers.filter(isDirty).reduce((count, buffer) => count + Math.max(dirtyFields(buffer).length, 1), 0);
  // A topology command may have no text buffer; count its unresolved receipt until it settles.
  const pending = ui.pending;
  return fields + (pending && !buffers.some((buffer) => buffer.sent && buffer.key === pending.key) ? 1 : 0);
}

/** Receipts prove both saved revisions even when their following read fails; older replays cannot lower the floor. */
export function requireDraftRevision(floors: StudioUi["acknowledgedRevisions"], receipt: Pick<CommandResult, "draftId" | "documentRevision" | "layoutRevision">): StudioUi["acknowledgedRevisions"] {
  const previous = floors[receipt.draftId];
  return { ...floors, [receipt.draftId]: {
    documentRevision: Math.max(previous?.documentRevision ?? 0, receipt.documentRevision),
    layoutRevision: Math.max(previous?.layoutRevision ?? 0, receipt.layoutRevision),
  } };
}

/** Only a read covering every acknowledged revision can clear this draft's outstanding read failure/floor. */
export function afterDraftRead(ui: StudioUi, view: Pick<DraftView, "id" | "documentRevision" | "layoutRevision">): Pick<StudioUi, "acknowledgedRevisions" | "refreshFailed"> {
  const floor = ui.acknowledgedRevisions[view.id];
  if (floor && (view.documentRevision < floor.documentRevision || view.layoutRevision < floor.layoutRevision)) {
    return { acknowledgedRevisions: ui.acknowledgedRevisions, refreshFailed: true };
  }
  const acknowledgedRevisions = { ...ui.acknowledgedRevisions };
  delete acknowledgedRevisions[view.id];
  return { acknowledgedRevisions, refreshFailed: false };
}
