import { envelope, optional, parseGraphCommand, type ByDocument, type ByEntity, type Command, type GraphCommand } from "../../drafts/contracts/commands.ts";
import { INCLUSIONS, LIMITS, parseSourceRefs, REQUIREMENT_CATEGORIES, type Inclusion, type RequirementCategory, type SourceRef } from "../../drafts/contracts/scope-document.ts";
import { id, idList, invalid, keys, object, oneOf, text, version } from "../../drafts/contracts/strict.ts";

// Scope commands for POST D/commands (API Evidence, scope and activity). Same envelopes and guards as graph commands.
export type Verification = { description: string; responsibleRole: string };
export type RequirementFields = {
  title: string; statement: string; category: RequirementCategory; inclusion: Inclusion; sourceRefs: SourceRef[]; ownerId: string | null; verification: Verification | null;
};

export type ScopeCommand =
  | Command<"CONFIRM_FLOW", ByEntity, { flowId: string }>
  | Command<"CREATE_REQUIREMENT", ByDocument, RequirementFields>
  | Command<"UPDATE_REQUIREMENT", ByEntity, { requirementId: string } & Partial<RequirementFields>>
  | Command<"DELETE_REQUIREMENT", ByDocument, { requirementId: string; removeLinkIds: string[] }>
  | Command<"CONFIRM_REQUIREMENT", ByEntity, { requirementId: string }>
  | Command<"ADD_TRACE_LINK", ByDocument, { requirementId: string; nodeId: string; explanation: string }>
  | Command<"UPDATE_TRACE_LINK", ByEntity, { linkId: string; explanation: string }>
  | Command<"CONFIRM_TRACE_LINK", ByEntity, { linkId: string; expectedRequirementBehaviourVersion: number; expectedNodeBehaviourVersion: number }>
  | Command<"DELETE_TRACE_LINK", ByDocument, { linkId: string }>;
export type DraftCommand = GraphCommand | ScopeCommand;

export const SCOPE_COMMANDS: ReadonlySet<string> = new Set([
  "CONFIRM_FLOW", "CREATE_REQUIREMENT", "UPDATE_REQUIREMENT", "DELETE_REQUIREMENT", "CONFIRM_REQUIREMENT", "ADD_TRACE_LINK", "UPDATE_TRACE_LINK", "CONFIRM_TRACE_LINK", "DELETE_TRACE_LINK",
]);
export const isScopeCommand = (command: { command: string }): command is ScopeCommand => SCOPE_COMMANDS.has(command.command);

const REQUIREMENT_KEYS = ["title", "statement", "category", "inclusion", "sourceRefs", "ownerId", "verification"] as const;
function verification(value: unknown): Verification | null {
  if (value === null) return null;
  const method = object(value);
  keys(method, ["description", "responsibleRole"]);
  return { description: text(method.description, LIMITS.longText, true), responsibleRole: text(method.responsibleRole, LIMITS.role, true) };
}
const parsers = {
  title: (value: unknown) => text(value, LIMITS.title, true),
  statement: (value: unknown) => text(value, LIMITS.longText),
  category: (value: unknown) => oneOf(value, REQUIREMENT_CATEGORIES),
  inclusion: (value: unknown) => oneOf(value, INCLUSIONS),
  sourceRefs: parseSourceRefs,
  ownerId: (value: unknown) => (value === null ? null : id(value)),
  verification,
};
const explanation = (value: unknown) => text(value, LIMITS.longText);

export function parseScopeCommand(raw: unknown): ScopeCommand {
  const body = object(raw);
  if (body.commandSchemaVersion !== 1) invalid();
  switch (body.command) {
    case "CREATE_REQUIREMENT": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", REQUIREMENT_KEYS);
      return { commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: guard, payload: {
        title: parsers.title(payload.title), statement: parsers.statement(payload.statement), category: parsers.category(payload.category), inclusion: parsers.inclusion(payload.inclusion),
        sourceRefs: parsers.sourceRefs(payload.sourceRefs), ownerId: parsers.ownerId(payload.ownerId), verification: verification(payload.verification),
      } };
    }
    case "UPDATE_REQUIREMENT": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["requirementId"], REQUIREMENT_KEYS);
      return { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: guard, payload: {
        requirementId: id(payload.requirementId), ...optional(payload, "title", parsers.title), ...optional(payload, "statement", parsers.statement),
        ...optional(payload, "category", parsers.category), ...optional(payload, "inclusion", parsers.inclusion), ...optional(payload, "sourceRefs", parsers.sourceRefs),
        ...optional(payload, "ownerId", parsers.ownerId), ...optional(payload, "verification", verification),
      } };
    }
    case "DELETE_REQUIREMENT": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["requirementId", "removeLinkIds"]);
      return { commandSchemaVersion: 1, command: "DELETE_REQUIREMENT", expectedDocumentRevision: guard, payload: { requirementId: id(payload.requirementId), removeLinkIds: idList(payload.removeLinkIds, LIMITS.traceLinks) } };
    }
    case "CONFIRM_FLOW": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["flowId"]);
      return { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: guard, payload: { flowId: id(payload.flowId) } };
    }
    case "CONFIRM_REQUIREMENT": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["requirementId"]);
      return { commandSchemaVersion: 1, command: "CONFIRM_REQUIREMENT", expectedEntityVersion: guard, payload: { requirementId: id(payload.requirementId) } };
    }
    case "ADD_TRACE_LINK": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["requirementId", "nodeId", "explanation"]);
      return { commandSchemaVersion: 1, command: "ADD_TRACE_LINK", expectedDocumentRevision: guard, payload: { requirementId: id(payload.requirementId), nodeId: id(payload.nodeId), explanation: explanation(payload.explanation) } };
    }
    case "UPDATE_TRACE_LINK": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["linkId", "explanation"]);
      return { commandSchemaVersion: 1, command: "UPDATE_TRACE_LINK", expectedEntityVersion: guard, payload: { linkId: id(payload.linkId), explanation: explanation(payload.explanation) } };
    }
    case "CONFIRM_TRACE_LINK": {
      const { guard, payload } = envelope(body, "expectedEntityVersion", ["linkId", "expectedRequirementBehaviourVersion", "expectedNodeBehaviourVersion"]);
      return { commandSchemaVersion: 1, command: "CONFIRM_TRACE_LINK", expectedEntityVersion: guard, payload: {
        linkId: id(payload.linkId), expectedRequirementBehaviourVersion: version(payload.expectedRequirementBehaviourVersion), expectedNodeBehaviourVersion: version(payload.expectedNodeBehaviourVersion),
      } };
    }
    case "DELETE_TRACE_LINK": {
      const { guard, payload } = envelope(body, "expectedDocumentRevision", ["linkId"]);
      return { commandSchemaVersion: 1, command: "DELETE_TRACE_LINK", expectedDocumentRevision: guard, payload: { linkId: id(payload.linkId) } };
    }
    default:
      return invalid();
  }
}

/** One D/commands body: a scope command when its name is one, otherwise a graph command. */
export function parseDraftCommand(raw: unknown): DraftCommand {
  const name = object(raw).command;
  return typeof name === "string" && SCOPE_COMMANDS.has(name) ? parseScopeCommand(raw) : parseGraphCommand(raw);
}
