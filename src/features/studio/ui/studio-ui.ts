import type { CommandResult } from "../../drafts/contracts/commands.ts";
import { COORDINATE_LIMIT, type DraftLayout } from "../../drafts/contracts/draft-layout.ts";
import { NODE_KINDS, type DraftView, type NodeKind } from "../../drafts/contracts/scope-document.ts";
import { dirtyFields, isDirty, type Buffers } from "./buffers.ts";
import { emptyOutbox, pendingCount, type Outbox } from "./outbox.ts";

export { isNewer } from "./outbox.ts";

// The Studio's slice of the shell's per-project UI store (UI00 "Per-project UI state"). Memory only: none of it is
// written to browser storage, and a project switch keeps it until the project is dropped or its edits discarded.
export type Selection = { kind: "NODES"; ids: string[] } | { kind: "EDGE"; id: string } | { kind: "FLOW"; id: string } | null;
export type StudioView = "canvas" | "list";
type RevisionFloor = Pick<DraftView, "documentRevision" | "layoutRevision">;
export type SaveState = { state: "idle" | "saving" | "saved" | "failed"; message: string };
/** Unsaved changes are saved every this many milliseconds while the Studio is idle (Save sends them sooner). */
export const AUTOSAVE_MS = 10_000;
// Every draft change waits in `outbox` until Save, autosave or a save-first action sends it (Task 14b). `request` is the
// key of the save or arrangement request in flight: a remounted provider must still see it and send nothing else.
// Endpoint buffers store document revisions in baseVersion and are applied only as RECONNECT_EDGE.
export type StudioUi = {
  acknowledgedRevisions: Record<string, RevisionFloor>; save: SaveState; refreshFailed: boolean; buffers: Buffers; endpointBuffers: Buffers;
  outbox: Outbox; request: string | null; flowId: string | null; selection: Selection; view: StudioView | null;
};
export const defaultStudioUi: StudioUi = {
  acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, buffers: {}, endpointBuffers: {},
  outbox: emptyOutbox, request: null, flowId: null, selection: null, view: null,
};
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

/** Typed text in buffers (one per dirty field) plus every unsaved change in the outbox, sent or not. */
export function studioDirtyCount(ui: StudioUi): number {
  const buffers = [...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers)];
  return buffers.filter(isDirty).reduce((count, buffer) => count + Math.max(dirtyFields(buffer).length, 1), 0) + pendingCount(ui.outbox);
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

/** A canvas coordinate as a saved one: whole pixels within +-COORDINATE_LIMIT (auto-pan and far drops can go past it). */
const saveable = (value: number) => Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, Math.round(value)));

/** Final drag positions worth keeping: rounded to whole pixels within the coordinate limit, and only for steps that moved from where they showed. */
export function moveTargets(moved: { id: string; position: { x: number; y: number } }[], layout: DraftLayout): { nodeId: string; x: number; y: number }[] {
  return moved.flatMap(({ id, position }) => {
    const shown = layout.positions[id];
    const x = saveable(position.x), y = saveable(position.y);
    return shown && (shown.x !== x || shown.y !== y) ? [{ nodeId: id, x, y }] : [];
  });
}

// Shape panel drag-and-drop (UI02 Task 7): the payload names a kind and its fixed STEP_SIZE, so a drop never has to
// trust dataTransfer for anything besides which shape was picked.
export const SHAPE_DRAG_MIME = "application/x-scoperoom-shape";
export type ShapeDragPayload = { kind: NodeKind; width: number; height: number };

/** The dropped or dragged payload, or null for anything malformed or an unknown kind (dropped silently). */
export function parseShapePayload(raw: string): ShapeDragPayload | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { kind, width, height } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !(NODE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return { kind: kind as NodeKind, width, height };
}

// Which end of a drawn connection is "from" (UI02 Task 13). React Flow labels a finished connection's ends by handle
// TYPE (source-typed handle first), not by gesture: dragging from a target-typed handle (top or left by default) hands
// `onConnect` the dropped step as `source`. A saved connection's direction must follow the person's gesture instead.
type Ends = { source: string; target: string; sourceHandle: string | null; targetHandle: string | null };
export type Oriented = { fromId: string; toId: string; fromHandle: string | null; toHandle: string | null };

/** A new connection: `from` is the step and handle where the drag started, `to` where it was dropped. */
export function orientConnect(connection: Ends, start: { nodeId: string | null; handleId: string | null } | null): Oriented {
  const asIs = { fromId: connection.source, toId: connection.target, fromHandle: connection.sourceHandle, toHandle: connection.targetHandle };
  const swapped = { fromId: connection.target, toId: connection.source, fromHandle: connection.targetHandle, toHandle: connection.sourceHandle };
  if (!start?.nodeId) return asIs;
  const atSource = start.nodeId === connection.source, atTarget = start.nodeId === connection.target;
  if (atSource && atTarget) return start.handleId === connection.targetHandle && start.handleId !== connection.sourceHandle ? swapped : asIs; // a step joined to itself
  return atTarget ? swapped : asIs;
}

/**
 * Reconnecting one end of an existing connection: the dragged end (`dragged`: the end of the OLD edge that was grabbed,
 * `source` = its from end) takes the drop point; the other end keeps its step and its side (`keptSide`, falling back to
 * what the connection reports, then to the direction's default handle).
 */
export function orientReconnect(
  connection: Ends, edge: { fromId: string; toId: string }, dragged: "source" | "target" | null,
  keptSide: string | null | undefined, fallbackSide: string,
): Oriented {
  const asIs = { fromId: connection.source, toId: connection.target, fromHandle: connection.sourceHandle, toHandle: connection.targetHandle };
  if (!dragged) return asIs;
  const keptId = dragged === "source" ? edge.toId : edge.fromId;
  const ends = [{ id: connection.source, handle: connection.sourceHandle }, { id: connection.target, handle: connection.targetHandle }];
  // The kept end is the one still on its step; joined to itself, the one that still has the kept handle, else the one that has not moved role.
  let keptAt = ends.findIndex((end) => end.id === keptId);
  if (keptAt >= 0 && ends[1 - keptAt]!.id === keptId) {
    const byHandle = ends.findIndex((end) => end.handle === keptSide);
    keptAt = byHandle >= 0 ? byHandle : dragged === "source" ? 1 : 0;
  }
  if (keptAt < 0) return asIs;
  const kept = ends[keptAt]!, moved = ends[1 - keptAt]!;
  const keptHandle = keptSide ?? kept.handle ?? fallbackSide;
  return dragged === "source"
    ? { fromId: moved.id, toId: keptId, fromHandle: moved.handle, toHandle: keptHandle }
    : { fromId: keptId, toId: moved.id, fromHandle: keptHandle, toHandle: moved.handle };
}

/** A drop or click point, centred to a top-left step position, rounded to whole pixels and kept within the coordinate limit (Data02 coordinates). */
export function dropTarget(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return { x: saveable(point.x - size.width / 2), y: saveable(point.y - size.height / 2) };
}
