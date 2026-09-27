import { coordinate, DIRECTIONS, type Direction, type SavedPosition } from "./draft-layout.ts";
import { id, invalid, keys, object, oneOf, text, version } from "./strict.ts";

// Position commands for POST D/positions and the nonmutating POST D/arrangement-preview (Data03 "Final position save").
// Moves carry only touched nodes and their expected position versions; an arrangement names the exact preview it
// accepts, and the server recomputes it — the browser never supplies replacement positions for an arrangement.
export const MAX_MOVE_NODES = 20;
export const POSITION_BODY_LIMIT = 16 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;

export type MoveItem = { nodeId: string; expectedPositionVersion: number; x: number; y: number };
export type MoveNodes = { mode: "MOVE_NODES"; flowId: string; items: MoveItem[] };
export type ArrangeFlow = {
  mode: "ARRANGE_FLOW"; flowId: string; expectedDocumentRevision: number; expectedLayoutRevision: number;
  direction: Direction; algorithmVersion: string; arrangementHash: string;
};
export type PositionCommand = MoveNodes | ArrangeFlow;
export type ArrangementRequest = { flowId: string; expectedDocumentRevision: number; expectedLayoutRevision: number; direction: Direction };
export type ArrangementPreview = {
  flowId: string; documentRevision: number; layoutRevision: number; direction: Direction; algorithmVersion: string;
  positions: Record<string, { x: number; y: number }>; arrangementHash: string;
};
/** A saved position change and its receipt: the new saved position and version of every node that actually moved. */
export type PositionResult = { draftId: string; layoutRevision: number; eventSequence: number; positions: Record<string, SavedPosition>; replayed: boolean };

export function parsePositionCommand(raw: unknown): PositionCommand {
  const body = object(raw);
  if (body.mode === "MOVE_NODES") {
    keys(body, ["mode", "flowId", "items"]);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_MOVE_NODES) invalid();
    const items = body.items.map((entry) => {
      const item = object(entry);
      keys(item, ["nodeId", "expectedPositionVersion", "x", "y"]);
      return { nodeId: id(item.nodeId), expectedPositionVersion: version(item.expectedPositionVersion), x: coordinate(item.x), y: coordinate(item.y) };
    });
    if (new Set(items.map((item) => item.nodeId)).size !== items.length) invalid();
    return { mode: "MOVE_NODES", flowId: id(body.flowId), items };
  }
  if (body.mode === "ARRANGE_FLOW") {
    keys(body, ["mode", "flowId", "expectedDocumentRevision", "expectedLayoutRevision", "direction", "algorithmVersion", "arrangementHash"]);
    if (typeof body.arrangementHash !== "string" || !hashPattern.test(body.arrangementHash)) invalid();
    return {
      mode: "ARRANGE_FLOW", flowId: id(body.flowId), expectedDocumentRevision: version(body.expectedDocumentRevision),
      expectedLayoutRevision: version(body.expectedLayoutRevision), direction: oneOf(body.direction, DIRECTIONS),
      algorithmVersion: text(body.algorithmVersion, 64, true), arrangementHash: body.arrangementHash,
    };
  }
  return invalid();
}

export function parseArrangementRequest(raw: unknown): ArrangementRequest {
  const body = object(raw);
  keys(body, ["flowId", "expectedDocumentRevision", "expectedLayoutRevision", "direction"]);
  return { flowId: id(body.flowId), expectedDocumentRevision: version(body.expectedDocumentRevision), expectedLayoutRevision: version(body.expectedLayoutRevision), direction: oneOf(body.direction, DIRECTIONS) };
}

/** Validates a stored receipt result before it is replayed. */
export function parsePositionResult(value: unknown): Omit<PositionResult, "replayed"> {
  const result = object(value);
  keys(result, ["draftId", "layoutRevision", "eventSequence", "positions"]);
  if (typeof result.eventSequence !== "number" || !Number.isSafeInteger(result.eventSequence) || result.eventSequence < 0) invalid();
  const positions = Object.fromEntries(Object.entries(object(result.positions)).map(([nodeId, entry]) => {
    const position = object(entry);
    keys(position, ["x", "y", "version"]);
    return [id(nodeId), { x: coordinate(position.x), y: coordinate(position.y), version: version(position.version) }];
  }));
  return { draftId: id(result.draftId), layoutRevision: version(result.layoutRevision), eventSequence: result.eventSequence, positions };
}
