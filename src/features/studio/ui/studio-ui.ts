import type { CommandResult, GraphCommand } from "../../drafts/contracts/commands.ts";
import type { DraftLayout, SavedPosition } from "../../drafts/contracts/draft-layout.ts";
import { MAX_MOVE_NODES, type MoveItem, type MoveNodes } from "../../drafts/contracts/positions.ts";
import { NODE_KINDS, type DraftView, type NodeKind } from "../../drafts/contracts/scope-document.ts";
import { dirtyFields, isDirty, type Buffers } from "./buffers.ts";

// The Studio's slice of the shell's per-project UI store (UI00 "Per-project UI state"). Memory only: none of it is
// written to browser storage, and a project switch keeps it until the project is dropped or its edits discarded.
export type Selection = { kind: "NODES"; ids: string[] } | { kind: "EDGE"; id: string } | { kind: "FLOW"; id: string } | null;
export type StudioView = "canvas" | "list";
type RevisionFloor = Pick<DraftView, "documentRevision" | "layoutRevision">;
export type SaveState = { state: "idle" | "saving" | "saved" | "failed"; message: string };
export type PendingCommand = { draftId: string; command: GraphCommand; key: string; inFlight: boolean };
/** The person's last acknowledged move: where each step was before it, and the position version the move saved. */
export type LastMove = { flowId: string; items: { nodeId: string; x: number; y: number; version: number }[] };
/** A position save the person made. Its placement is shown over the saved layout until it is saved, dropped or reapplied. */
export type Attempt = { draftId: string; flowId: string; command: MoveNodes; key: string; before: Record<string, { x: number; y: number }>; undo: boolean; state: "pending" | "uncertain" | "conflict" };
/**
 * A step the person dropped that is not saved yet (buffered position saves, Task 12). `expectedVersion` is the saved
 * position version when the step was FIRST moved locally, so a later save never silently overwrites someone else's move.
 */
export type UnsavedMove = { flowId: string; x: number; y: number; expectedVersion: number };
export type UnsavedMoves = Record<string, UnsavedMove>;
/** One local drop, for Undo: each step's unsaved move before it (null: it was showing its saved position). */
export type LocalDrop = { flowId: string; items: { nodeId: string; prior: UnsavedMove | null }[] };
type Moves = Pick<StudioUi, "unsavedMoves" | "drops">;
/** Unsaved moves are saved every this many milliseconds while the Studio is idle (Save sends them sooner). */
export const AUTOSAVE_MS = 10_000;
// Endpoint buffers store document revisions in baseVersion and are sent only as RECONNECT_EDGE.
// Position state sits beside the command receipt for the same reason: a remounted provider must still see the request
// in flight (`placing` is its key) and the unresolved attempt. `placement` is reported apart from content `save`.
export type StudioUi = {
  acknowledgedRevisions: Record<string, RevisionFloor>; save: SaveState; refreshFailed: boolean; pending: PendingCommand | null; buffers: Buffers; endpointBuffers: Buffers;
  placement: SaveState; placing: string | null; attempt: Attempt | null; lastMove: LastMove | null; unsavedMoves: UnsavedMoves; drops: LocalDrop[]; flowId: string | null; selection: Selection; view: StudioView | null;
};
export const defaultStudioUi: StudioUi = {
  acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, pending: null, buffers: {}, endpointBuffers: {},
  placement: { state: "idle", message: "" }, placing: null, attempt: null, lastMove: null, unsavedMoves: {}, drops: [], flowId: null, selection: null, view: null,
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

/** A later read of the same draft: neither revision went backwards. Late responses fail this and are dropped. */
export function isNewer(candidate: DraftView, current: DraftView): boolean {
  return candidate.id === current.id && candidate.documentRevision >= current.documentRevision && candidate.layoutRevision >= current.layoutRevision;
}

/** Text edits and endpoint choices share leave-guard/status semantics, but use different commands. Unsaved step
 * positions count too, one per step, plus a position save their steps do not already count (an unconfirmed undo). */
export function studioDirtyCount(ui: StudioUi): number {
  const buffers = [...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers)];
  const fields = buffers.filter(isDirty).reduce((count, buffer) => count + Math.max(dirtyFields(buffer).length, 1), 0);
  // A topology command may have no text buffer; count its unresolved receipt until it settles.
  const pending = ui.pending;
  const { attempt, unsavedMoves } = ui;
  const placement = Object.keys(unsavedMoves).length + (attempt && !attempt.command.items.some((item) => unsavedMoves[item.nodeId]) ? 1 : 0);
  return fields + placement + (pending && !buffers.some((buffer) => buffer.sent && buffer.key === pending.key) ? 1 : 0);
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

/** Undo is offered only while every step of the last own move still has the version that move saved. */
export function canUndo(lastMove: LastMove | null, layout: DraftLayout): boolean {
  return Boolean(lastMove?.items.length) && lastMove!.items.every((item) => layout.positions[item.nodeId]?.version === item.version);
}

/** Final drag positions worth keeping: rounded to whole pixels, and only for steps that moved from where they showed. */
export function moveTargets(moved: { id: string; position: { x: number; y: number } }[], layout: DraftLayout, unsaved: UnsavedMoves = {}): { nodeId: string; x: number; y: number }[] {
  return moved.flatMap(({ id, position }) => {
    const shown = layout.positions[id] && (unsaved[id] ?? layout.positions[id]);
    const x = Math.round(position.x), y = Math.round(position.y);
    return shown && (shown.x !== x || shown.y !== y) ? [{ nodeId: id, x, y }] : [];
  });
}

/** Records one drop as unsaved moves (a step dropped back on its saved spot has nothing left to save) and its undo. */
export function recordDrop(moves: Moves, flowId: string, targets: { nodeId: string; x: number; y: number }[], layout: DraftLayout): Moves {
  const unsavedMoves = { ...moves.unsavedMoves };
  const items: LocalDrop["items"] = [];
  for (const { nodeId, x, y } of targets) {
    const saved = layout.positions[nodeId];
    if (!saved) continue;
    const prior = unsavedMoves[nodeId] ?? null;
    items.push({ nodeId, prior });
    if (saved.x === x && saved.y === y) delete unsavedMoves[nodeId];
    else unsavedMoves[nodeId] = { flowId, x, y, expectedVersion: prior?.expectedVersion ?? saved.version };
  }
  if (!items.length) return moves;
  // Back to fully saved: Undo is the saved-move undo again, not a replay of these local drops.
  return { unsavedMoves, drops: Object.keys(unsavedMoves).length ? [...moves.drops, { flowId, items }] : [] };
}

/** Reverts the most recent local drop without a request. */
export function undoDrop(moves: Moves): Moves {
  const last = moves.drops.at(-1);
  if (!last) return moves;
  const unsavedMoves = { ...moves.unsavedMoves };
  for (const { nodeId, prior } of last.items) {
    if (prior) unsavedMoves[nodeId] = prior;
    else delete unsavedMoves[nodeId];
  }
  return { unsavedMoves, drops: moves.drops.slice(0, -1) };
}

/** Local undo history only for steps that still have an unsaved move. */
function pruneDrops(drops: LocalDrop[], unsavedMoves: UnsavedMoves): LocalDrop[] {
  return drops.map((drop) => ({ ...drop, items: drop.items.filter((item) => unsavedMoves[item.nodeId]) })).filter((drop) => drop.items.length);
}

/** Drops unsaved moves for steps that were deleted, or whose saved position the person chose to keep. */
export function forgetMoves(moves: Moves, nodeIds: Iterable<string>): Moves {
  const unsavedMoves = { ...moves.unsavedMoves };
  for (const nodeId of nodeIds) delete unsavedMoves[nodeId];
  return { unsavedMoves, drops: pruneDrops(moves.drops, unsavedMoves) };
}

/**
 * An acknowledged MOVE_NODES chunk (all-or-nothing): each sent step is saved where it was sent. A step moved again since
 * keeps its newer spot, now expected at the version this save gave it (`saved`, from the receipt).
 */
export function settleMoves(moves: Moves, sent: MoveItem[], saved: Record<string, SavedPosition>): Moves {
  const unsavedMoves = { ...moves.unsavedMoves };
  for (const item of sent) {
    const move = unsavedMoves[item.nodeId];
    if (!move) continue;
    if (move.x === item.x && move.y === item.y) delete unsavedMoves[item.nodeId];
    else if (saved[item.nodeId]) unsavedMoves[item.nodeId] = { ...move, expectedVersion: saved[item.nodeId]!.version };
  }
  return { unsavedMoves, drops: pruneDrops(moves.drops, unsavedMoves) };
}

/** A flush's requests: one flow at a time, at most MAX_MOVE_NODES steps each, never a step no longer in the document. */
export function moveChunks(unsavedMoves: UnsavedMoves, layout: DraftLayout, nodes: Record<string, { flowId: string }>): MoveNodes[] {
  const byFlow = new Map<string, MoveItem[]>();
  for (const [nodeId, move] of Object.entries(unsavedMoves)) {
    const node = nodes[nodeId];
    if (!node || !layout.positions[nodeId]) continue;
    const items = byFlow.get(node.flowId) ?? [];
    items.push({ nodeId, expectedPositionVersion: move.expectedVersion, x: move.x, y: move.y });
    byFlow.set(node.flowId, items);
  }
  return [...byFlow].flatMap(([flowId, items]) => Array.from({ length: Math.ceil(items.length / MAX_MOVE_NODES) },
    (_, index) => ({ mode: "MOVE_NODES" as const, flowId, items: items.slice(index * MAX_MOVE_NODES, (index + 1) * MAX_MOVE_NODES) })));
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

/** A drop or click point, centred to a top-left step position and rounded to whole pixels (Data02 coordinates). */
export function dropTarget(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };
}
