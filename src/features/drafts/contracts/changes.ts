import { parseGraphCommand, type GraphCommand } from "./commands.ts";
import { parseMoveItem, type MoveItem } from "./positions.ts";
import { LIMITS } from "./scope-document.ts";
import { id, idList, invalid, keys, object, version } from "./strict.ts";

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
 * A saved batch and its receipt: only the counters. The receipt is capped at 64 KiB and a valid batch can create far
 * more ids than fit, so it never lists them: the browser keeps its proposed ids and re-reads the draft after a save.
 */
export type ChangesResult = { draftId: string; documentRevision: number; layoutRevision: number; eventSequence: number; replayed: boolean };

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

/** Validates a stored receipt result before it is replayed. */
export function parseChangesResult(value: unknown): Omit<ChangesResult, "replayed"> {
  const result = object(value);
  keys(result, ["draftId", "documentRevision", "layoutRevision", "eventSequence"]);
  if (typeof result.eventSequence !== "number" || !Number.isSafeInteger(result.eventSequence) || result.eventSequence < 0) invalid();
  return {
    draftId: id(result.draftId), documentRevision: version(result.documentRevision), layoutRevision: version(result.layoutRevision), eventSequence: result.eventSequence,
  };
}
