import { CLASSIFICATIONS, INCLUSIONS, LIMITS, NODE_KINDS, type Classification, type Inclusion, type NodeKind } from "./scope-document.ts";
import { id, idList, invalid, keys, object, oneOf, text, version } from "./strict.ts";

// Graph commands for POST D/commands (API "Drafts and manual Studio"). Single-record edits guard the record's version;
// topology changes guard the exact documentRevision, which advances on every semantic change and so also covers
// every record version they touch. The browser never sends a replacement document or layout.
export const COMMAND_SCHEMA_VERSION = 1;
export const COMMAND_BODY_LIMIT = 64 * 1024;
export const MAX_DELETE_NODES = 20;

export type FlowFields = { title: string; purpose: string; classification: Classification; inclusion: Inclusion };
export type NodeFields = { kind: NodeKind; label: string; description: string; actorLabel: string; assumptionNotes: string[] };

type Command<Name extends string, Guard, Payload> = { commandSchemaVersion: 1; command: Name; payload: Payload } & Guard;
type ByDocument = { expectedDocumentRevision: number };
type ByEntity = { expectedEntityVersion: number };

export type GraphCommand =
  | Command<"CREATE_FLOW", ByDocument, FlowFields>
  | Command<"UPDATE_FLOW", ByEntity, { flowId: string } & Partial<FlowFields>>
  | Command<"DUPLICATE_FLOW", ByDocument, { flowId: string }>
  | Command<"DELETE_FLOW", ByDocument, { flowId: string; removeNodeIds: string[]; removeEdgeIds: string[] }>
  | Command<"ADD_NODE", ByDocument, { flowId: string } & Omit<NodeFields, "assumptionNotes">>
  | Command<"UPDATE_NODE", ByEntity, { nodeId: string } & Partial<NodeFields>>
  | Command<"DELETE_NODES", ByDocument, { flowId: string; nodeIds: string[]; removeEdgeIds: string[] }>
  | Command<"ADD_EDGE", ByDocument, { flowId: string; fromId: string; toId: string; condition: string }>
  | Command<"UPDATE_EDGE", ByEntity, { edgeId: string; condition: string }>
  | Command<"RECONNECT_EDGE", ByDocument, { edgeId: string; fromId: string; toId: string }>
  | Command<"DELETE_EDGE", ByDocument, { edgeId: string }>;

/**
 * A saved command's result, which its receipt also replays: identifiers and counters only, never document text.
 * `versions` holds the new record version of each pre-existing flow, node or edge the command changed.
 */
export type CommandResult = {
  draftId: string; documentRevision: number; layoutRevision: number; eventSequence: number;
  createdIds: string[]; versions: Record<string, number>; retiredIds: string[]; replayed: boolean;
};

const title = (value: unknown) => text(value, LIMITS.title, true);
const label = (value: unknown) => text(value, LIMITS.label, true);
const longText = (value: unknown) => text(value, LIMITS.longText);
const actorLabel = (value: unknown) => text(value, LIMITS.actorLabel);
const condition = (value: unknown) => text(value, LIMITS.condition);
function notes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > LIMITS.notes) invalid();
  return value.map((note) => text(note, LIMITS.note, true));
}

/** Parses `payload[key]` only when the key is present, so an update carries just the fields it changes. */
function optional<K extends string, T>(payload: Record<string, unknown>, key: K, parse: (value: unknown) => T): { [P in K]?: T } {
  return (Object.hasOwn(payload, key) ? { [key]: parse(payload[key]) } : {}) as { [P in K]?: T };
}

function envelope(body: Record<string, unknown>, guard: keyof ByDocument | keyof ByEntity, required: readonly string[], updatable: readonly string[] = []) {
  keys(body, ["commandSchemaVersion", "command", guard, "payload"]);
  const payload = object(body.payload);
  keys(payload, required, updatable);
  if (updatable.length && !updatable.some((key) => Object.hasOwn(payload, key))) invalid(); // an update changes something
  return { guard: version(body[guard]), payload };
}

export function parseGraphCommand(raw: unknown): GraphCommand {
  const body = object(raw);
  if (body.commandSchemaVersion !== COMMAND_SCHEMA_VERSION) invalid();
  switch (body.command) {
    case "CREATE_FLOW": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["title", "purpose", "classification", "inclusion"]);
      return { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: guard, payload: {
        title: title(payload.title), purpose: longText(payload.purpose), classification: oneOf(payload.classification, CLASSIFICATIONS), inclusion: oneOf(payload.inclusion, INCLUSIONS),
      } };
    }
    case "UPDATE_FLOW": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["flowId"], ["title", "purpose", "classification", "inclusion"]);
      return { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: guard, payload: {
        flowId: id(payload.flowId), ...optional(payload, "title", title), ...optional(payload, "purpose", longText),
        ...optional(payload, "classification", (value) => oneOf(value, CLASSIFICATIONS)), ...optional(payload, "inclusion", (value) => oneOf(value, INCLUSIONS)),
      } };
    }
    case "DUPLICATE_FLOW": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["flowId"]);
      return { commandSchemaVersion: 1, command: "DUPLICATE_FLOW", expectedDocumentRevision: guard, payload: { flowId: id(payload.flowId) } };
    }
    case "DELETE_FLOW": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["flowId", "removeNodeIds", "removeEdgeIds"]);
      return { commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: guard, payload: {
        flowId: id(payload.flowId), removeNodeIds: idList(payload.removeNodeIds, LIMITS.nodes), removeEdgeIds: idList(payload.removeEdgeIds, LIMITS.edges),
      } };
    }
    case "ADD_NODE": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["flowId", "kind", "label", "description", "actorLabel"]);
      return { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: guard, payload: {
        flowId: id(payload.flowId), kind: oneOf(payload.kind, NODE_KINDS), label: label(payload.label), description: longText(payload.description), actorLabel: actorLabel(payload.actorLabel),
      } };
    }
    case "UPDATE_NODE": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["nodeId"], ["kind", "label", "description", "actorLabel", "assumptionNotes"]);
      return { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: guard, payload: {
        nodeId: id(payload.nodeId), ...optional(payload, "kind", (value) => oneOf(value, NODE_KINDS)), ...optional(payload, "label", label),
        ...optional(payload, "description", longText), ...optional(payload, "actorLabel", actorLabel), ...optional(payload, "assumptionNotes", notes),
      } };
    }
    case "DELETE_NODES": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["flowId", "nodeIds", "removeEdgeIds"]);
      const nodeIds = idList(payload.nodeIds, MAX_DELETE_NODES);
      if (!nodeIds.length) invalid();
      return { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: guard, payload: {
        flowId: id(payload.flowId), nodeIds, removeEdgeIds: idList(payload.removeEdgeIds, LIMITS.edges),
      } };
    }
    case "ADD_EDGE": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["flowId", "fromId", "toId", "condition"]);
      return { commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: guard, payload: {
        flowId: id(payload.flowId), fromId: id(payload.fromId), toId: id(payload.toId), condition: condition(payload.condition),
      } };
    }
    case "UPDATE_EDGE": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["edgeId", "condition"]);
      return { commandSchemaVersion: 1, command: "UPDATE_EDGE", expectedEntityVersion: guard, payload: { edgeId: id(payload.edgeId), condition: condition(payload.condition) } };
    }
    case "RECONNECT_EDGE": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["edgeId", "fromId", "toId"]);
      return { commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: guard, payload: { edgeId: id(payload.edgeId), fromId: id(payload.fromId), toId: id(payload.toId) } };
    }
    case "DELETE_EDGE": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["edgeId"]);
      return { commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: guard, payload: { edgeId: id(payload.edgeId) } };
    }
    default:
      return invalid();
  }
}

const MAX_RESULT_IDS = LIMITS.flows + LIMITS.nodes + LIMITS.edges;

/** Validates a stored receipt result before it is replayed. */
export function parseCommandResult(value: unknown): Omit<CommandResult, "replayed"> {
  const result = object(value);
  keys(result, ["draftId", "documentRevision", "layoutRevision", "eventSequence", "createdIds", "versions", "retiredIds"]);
  if (typeof result.eventSequence !== "number" || !Number.isSafeInteger(result.eventSequence) || result.eventSequence < 0) invalid();
  return {
    draftId: id(result.draftId), documentRevision: version(result.documentRevision), layoutRevision: version(result.layoutRevision), eventSequence: result.eventSequence,
    createdIds: idList(result.createdIds, MAX_RESULT_IDS), retiredIds: idList(result.retiredIds, MAX_RESULT_IDS),
    versions: Object.fromEntries(Object.entries(object(result.versions)).map(([key, entry]) => [id(key), version(entry)])),
  };
}
