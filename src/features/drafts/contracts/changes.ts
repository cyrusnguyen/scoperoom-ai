import { parseGraphCommand, type GraphCommand } from "./commands.ts";
import type { SavedPosition } from "./draft-layout.ts";
import { parseMoveItem, parseSavedPositions, type MoveItem } from "./positions.ts";
import { LIMITS } from "./scope-document.ts";
import { id, idList, invalid, keys, object, utf8Bytes, version } from "./strict.ts";

// The batch save for POST D/changes: every unsaved draft change in one transaction and one receipt. Commands keep
// their own guards, checked against the state the earlier items produced; create commands carry the ids the browser
// already uses (proposedIds), so a saved batch never renames anything. Moves follow the commands, grouped by flow.
export const CHANGES_BODY_LIMIT = 256 * 1024;
export const MAX_CHANGE_COMMANDS = 100;
export const MAX_CHANGE_MOVES = 200;
/** The most ids one command can create: DUPLICATE_FLOW of a full flow. */
const MAX_COMMAND_IDS = LIMITS.flows + LIMITS.nodes + LIMITS.edges;

export type Change = { command: GraphCommand; proposedIds: string[] };
export type MoveGroup = { flowId: string; items: MoveItem[] };
export type Changes = { commands: Change[]; moves: MoveGroup[] };
/**
 * A saved batch and its receipt: the ids it created (in order), the final record version of each live flow, node or
 * edge a command changed, and the saved position of every step a move actually moved.
 */
export type ChangesResult = {
  draftId: string; documentRevision: number; layoutRevision: number; eventSequence: number;
  createdIds: string[]; versions: Record<string, number>; positions: Record<string, SavedPosition>; replayed: boolean;
};

export function parseChanges(raw: unknown): Changes {
  const body = object(raw);
  keys(body, ["commands", "moves"]);
  if (!Array.isArray(body.commands) || body.commands.length > MAX_CHANGE_COMMANDS || !Array.isArray(body.moves)) invalid();
  const commands = body.commands.map((entry) => {
    const { proposedIds, ...command } = object(entry);
    return { command: parseGraphCommand(command), proposedIds: proposedIds === undefined ? [] : idList(proposedIds, MAX_COMMAND_IDS) };
  });
  const moves = body.moves.map((entry) => {
    const group = object(entry);
    keys(group, ["flowId", "items"]);
    if (!Array.isArray(group.items) || !group.items.length || group.items.length > MAX_CHANGE_MOVES) invalid();
    return { flowId: id(group.flowId), items: group.items.map(parseMoveItem) };
  });
  const nodeIds = moves.flatMap((group) => group.items.map((item) => item.nodeId));
  if (nodeIds.length > MAX_CHANGE_MOVES || new Set(nodeIds).size !== nodeIds.length || new Set(moves.map((group) => group.flowId)).size !== moves.length) invalid();
  if (!commands.length && !nodeIds.length) invalid();
  return { commands, moves };
}

/** Validates a stored receipt result before it is replayed. Created ids are bounded by the request body that proposed them. */
export function parseChangesResult(value: unknown): Omit<ChangesResult, "replayed"> {
  const result = object(value);
  if (utf8Bytes(result) > 2 * CHANGES_BODY_LIMIT) invalid();
  keys(result, ["draftId", "documentRevision", "layoutRevision", "eventSequence", "createdIds", "versions", "positions"]);
  if (typeof result.eventSequence !== "number" || !Number.isSafeInteger(result.eventSequence) || result.eventSequence < 0) invalid();
  return {
    draftId: id(result.draftId), documentRevision: version(result.documentRevision), layoutRevision: version(result.layoutRevision), eventSequence: result.eventSequence,
    createdIds: idList(result.createdIds, MAX_CHANGE_COMMANDS * MAX_COMMAND_IDS),
    versions: Object.fromEntries(Object.entries(object(result.versions)).map(([key, entry]) => [id(key), version(entry)])),
    positions: parseSavedPositions(result.positions),
  };
}
