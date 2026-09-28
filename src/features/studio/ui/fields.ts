import type { GraphCommand } from "../../drafts/contracts/commands.ts";
import { CLASSIFICATIONS, INCLUSIONS, LIMITS, NODE_KINDS, type EdgeRecord, type FlowRecord, type NodeRecord } from "../../drafts/contracts/scope-document.ts";
import { changes, dirtyFields, type EntityBuffer, type EntityKind, type Fields, type Saved } from "./buffers.ts";

// Form fields for the inspector and the Studio dialogs. Limits come from the draft contract, counted in code points,
// and are checked on Save — never by truncating what was typed (no `maxLength`: it silently cuts pasted text).
// OUTCOME keeps "Outcome" (not "End"): existing e2e specs select the Add step "Shape" option by this label.
export const KIND_LABELS = { START: "Start", ACTION: "Step", DECISION: "Decision", OUTCOME: "Outcome", DATA_STORE: "Data store" } as const;
export const INCLUSION_LABELS = { INCLUDED: "Included", EXCLUDED: "Excluded", UNDECIDED: "Exploratory" } as const;
export const CLASSIFICATION_LABELS = { USER_JOURNEY: "User journey", BUSINESS_PROCESS: "Business process" } as const;

export type FieldSpec = { name: string; label: string; max: number; required?: boolean; multiline?: boolean; options?: readonly (readonly [string, string])[]; hint?: string };

export const FIELDS: Record<EntityKind, FieldSpec[]> = {
  FLOW: [
    { name: "title", label: "Title", max: LIMITS.title, required: true },
    { name: "purpose", label: "Purpose", max: LIMITS.longText, multiline: true },
    { name: "classification", label: "Type", max: 40, options: CLASSIFICATIONS.map((value) => [value, CLASSIFICATION_LABELS[value]] as const) },
    { name: "inclusion", label: "Scope", max: 40, options: INCLUSIONS.map((value) => [value, INCLUSION_LABELS[value]] as const) },
  ],
  NODE: [
    { name: "label", label: "Name", max: LIMITS.label, required: true },
    { name: "kind", label: "Shape", max: 40, options: NODE_KINDS.map((value) => [value, KIND_LABELS[value]] as const) },
    { name: "actorLabel", label: "Actor", max: LIMITS.actorLabel },
    { name: "description", label: "Description", max: LIMITS.longText, multiline: true },
    { name: "assumptionNotes", label: "Assumptions", max: LIMITS.note, multiline: true, hint: `One per line, up to ${LIMITS.notes}.` },
  ],
  EDGE: [{ name: "condition", label: "Condition", max: LIMITS.condition, hint: "Leave empty for an unconditional step." }],
};

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const codePoints = (value: string) => [...value].length;

/** Saved values as form text; assumption notes become one line each. */
export const flowFields = (flow: FlowRecord): Fields => ({ title: flow.title, purpose: flow.purpose, classification: flow.classification, inclusion: flow.inclusion });
export const nodeFields = (node: NodeRecord): Fields => ({ label: node.label, kind: node.kind, actorLabel: node.actorLabel, description: node.description, assumptionNotes: node.assumptionNotes.join("\n") });
export const edgeFields = (edge: EdgeRecord): Fields => ({ condition: edge.condition });

export function savedOf(kind: EntityKind, record: FlowRecord | NodeRecord | EdgeRecord): Saved {
  const fields = kind === "FLOW" ? flowFields(record as FlowRecord) : kind === "NODE" ? nodeFields(record as NodeRecord) : edgeFields(record as EdgeRecord);
  return { kind, id: record.id, version: record.version, fields };
}

/** Field errors for the given values, in form order. Empty when the values can be sent. */
export function fieldErrors(kind: EntityKind, values: Fields): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const spec of FIELDS[kind]) {
    const value = values[spec.name];
    if (value === undefined) continue;
    if (!value.isWellFormed() || value.includes("\u0000")) errors[spec.name] = "Enter valid text.";
    else if (spec.required && !value.trim()) errors[spec.name] = `Enter a ${spec.label.toLowerCase()}.`;
    else if (spec.name === "assumptionNotes") {
      const notes = lines(value);
      if (notes.length > LIMITS.notes) errors[spec.name] = `Keep it to ${LIMITS.notes} assumptions.`;
      else if (notes.some((note) => codePoints(note) > LIMITS.note)) errors[spec.name] = `Each assumption can be up to ${LIMITS.note} characters.`;
    } else if (codePoints(value) > spec.max) errors[spec.name] = `${spec.label} can be up to ${spec.max} characters (now ${codePoints(value)}).`;
  }
  return errors;
}

export type InlinePlan = { kind: "unchanged" } | { kind: "refused"; message: string } | { kind: "review" } | { kind: "send"; fields: Fields };

/**
 * Closing an inline canvas editor applies that record's shared buffer like the inspector does (the same command, queued
 * in the outbox), limited to what was typed in the editor: `opened` is the text it showed when it opened, so opening
 * and closing it never queues anything. Other unsaved fields, and a stale conflict, go to the inspector for deliberate
 * review. Invalid text is refused but never discarded: the buffer keeps it (UI02 "Invalid fields retain text").
 */
export function inlinePlan(buffer: EntityBuffer | undefined, kind: EntityKind, field: string, opened: string): InlinePlan {
  if (!buffer || buffer.values[field] === buffer.original[field] || buffer.values[field] === opened) return { kind: "unchanged" };
  if (buffer.conflict) return { kind: "review" };
  const own = fieldErrors(kind, { [field]: buffer.values[field]! })[field];
  if (own) return { kind: "refused", message: own };
  return dirtyFields(buffer).some((name) => name !== field) ? { kind: "review" } : { kind: "send", fields: changes(buffer) };
}

/** The update command for changed fields, guarded by the version the edits were made against. */
export function updateCommand(kind: EntityKind, id: string, expectedEntityVersion: number, changed: Fields): GraphCommand {
  if (kind === "NODE") {
    const { assumptionNotes, ...rest } = changed;
    return { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion, payload: { nodeId: id, ...rest, ...(assumptionNotes === undefined ? {} : { assumptionNotes: lines(assumptionNotes) }) } } as GraphCommand;
  }
  if (kind === "FLOW") return { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion, payload: { flowId: id, ...changed } } as GraphCommand;
  if (changed.condition === undefined) throw new Error("Missing edge condition.");
  return { commandSchemaVersion: 1, command: "UPDATE_EDGE", expectedEntityVersion, payload: { edgeId: id, condition: changed.condition } };
}

/** Endpoint choices are a topology command, never fields of UPDATE_EDGE. */
export function reconnectCommand(id: string, expectedDocumentRevision: number, values: Fields): GraphCommand {
  return { commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision,
    payload: { edgeId: id, fromId: values.fromId!, toId: values.toId! } };
}
