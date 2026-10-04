import { MAX_DELETE_NODES } from "../../drafts/contracts/commands.ts";
import { CLASSIFICATIONS, INCLUSIONS, LIMITS, NODE_KINDS } from "../../drafts/contracts/scope-document.ts";
import { id, keys, object, oneOf, text } from "../../drafts/contracts/strict.ts";
import {
  AI_LIMITS, LOCAL_REF, TASK_EDITS, type CapturedInput, type EditCommand, type ProposalEdit, type ProposalOperation, type SourceRef, type ValidatedProposal,
} from "../contracts/tasks.ts";
import { jsonbTextBytes } from "./capture.ts";

/** Why a model output was refused. `reason` is a stable code for tests and support; it never carries model text. */
export class ResultError extends Error {
  readonly reason: string;
  constructor(reason: string) { super("INVALID_RESULT"); this.name = "ResultError"; this.reason = reason; }
}
const bad = (reason: string): never => { throw new ResultError(reason); };

export const NO_CHANGE: ValidatedProposal = { schemaVersion: 1, kind: "clarification", message: "No change is proposed for the selected steps." };

const ref = (value: unknown): string => (typeof value === "string" && LOCAL_REF.test(value) ? value : bad("REF"));
/** A captured UUID or an operation-local reference; which one is permitted is decided by the semantic pass. */
const entity = (value: unknown): string => (typeof value === "string" && LOCAL_REF.test(value) ? value : id(value));
const ids = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value) || value.length > max) return bad("LIST");
  const list = value.map(entity);
  return new Set(list).size === list.length ? list : bad("DUPLICATE_ID");
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value));

function parseEdit(task: CapturedInput["taskType"], raw: unknown): ProposalEdit {
  const edit = object(raw);
  keys(edit, ["command", "payload"]);
  const command = oneOf(edit.command, TASK_EDITS[task] as readonly EditCommand[]);
  const p = object(edit.payload);
  switch (command) {
    case "CREATE_FLOW":
      keys(p, ["ref", "title", "purpose", "classification", "inclusion"]);
      return { command, payload: { ref: ref(p.ref), title: text(p.title, LIMITS.title, true), purpose: text(p.purpose, LIMITS.longText), classification: oneOf(p.classification, CLASSIFICATIONS), inclusion: oneOf(p.inclusion, INCLUSIONS) } };
    case "ADD_NODE":
      keys(p, ["ref", "flowId", "kind", "label", "description", "actorLabel"]);
      return { command, payload: { ref: ref(p.ref), flowId: entity(p.flowId), kind: oneOf(p.kind, NODE_KINDS), label: text(p.label, LIMITS.label, true), description: text(p.description, LIMITS.longText), actorLabel: text(p.actorLabel, LIMITS.actorLabel) } };
    case "UPDATE_NODE": {
      keys(p, ["nodeId"], ["kind", "label", "description", "actorLabel", "assumptionNotes"]);
      const notes = Object.hasOwn(p, "assumptionNotes") ? p.assumptionNotes : undefined;
      if (Object.keys(p).length < 2) bad("EMPTY_UPDATE");
      if (notes !== undefined && (!Array.isArray(notes) || notes.length > LIMITS.notes)) bad("NOTES");
      return { command, payload: {
        nodeId: entity(p.nodeId),
        ...(Object.hasOwn(p, "kind") ? { kind: oneOf(p.kind, NODE_KINDS) } : {}), ...(Object.hasOwn(p, "label") ? { label: text(p.label, LIMITS.label, true) } : {}),
        ...(Object.hasOwn(p, "description") ? { description: text(p.description, LIMITS.longText) } : {}), ...(Object.hasOwn(p, "actorLabel") ? { actorLabel: text(p.actorLabel, LIMITS.actorLabel) } : {}),
        ...(notes ? { assumptionNotes: (notes as unknown[]).map((note) => text(note, LIMITS.note, true)) } : {}),
      } };
    }
    case "DELETE_NODES": {
      keys(p, ["flowId", "nodeIds", "removeEdgeIds"]);
      const nodeIds = ids(p.nodeIds, MAX_DELETE_NODES);
      return nodeIds.length ? { command, payload: { flowId: entity(p.flowId), nodeIds, removeEdgeIds: ids(p.removeEdgeIds, LIMITS.edges) } } : bad("EMPTY_DELETE");
    }
    case "ADD_EDGE":
      keys(p, ["flowId", "fromId", "toId", "condition"]);
      return { command, payload: { flowId: entity(p.flowId), fromId: entity(p.fromId), toId: entity(p.toId), condition: text(p.condition, LIMITS.condition) } };
    case "UPDATE_EDGE":
      keys(p, ["edgeId", "condition"]);
      return { command, payload: { edgeId: entity(p.edgeId), condition: text(p.condition, LIMITS.condition) } };
    case "RECONNECT_EDGE":
      keys(p, ["edgeId", "fromId", "toId"]);
      return { command, payload: { edgeId: entity(p.edgeId), fromId: entity(p.fromId), toId: entity(p.toId) } };
    case "DELETE_EDGE":
      keys(p, ["edgeId"]);
      return { command, payload: { edgeId: entity(p.edgeId) } };
  }
}

function parseOperations(capture: CapturedInput, raw: unknown): ProposalOperation[] {
  if (!Array.isArray(raw) || raw.length > AI_LIMITS.operations) return bad("OPERATIONS");
  const operations = raw.map((entry): ProposalOperation => {
    const op = object(entry);
    keys(op, ["id", "dependsOn", "edit"]);
    const dependsOn = Array.isArray(op.dependsOn) && op.dependsOn.length <= AI_LIMITS.dependsOn ? op.dependsOn.map(ref) : bad("DEPENDS_ON");
    return { id: ref(op.id), dependsOn, edit: parseEdit(capture.taskType, op.edit) };
  });
  const known = new Set(operations.map((op) => op.id));
  if (known.size !== operations.length) bad("DUPLICATE_OPERATION");
  for (const op of operations) {
    if (new Set(op.dependsOn).size !== op.dependsOn.length || op.dependsOn.some((dep) => dep === op.id || !known.has(dep))) bad("DEPENDS_ON");
  }
  return operations;
}

/** Everything an operation may name, derived only from the capture: the model never widens its own scope. */
function checkScope(capture: CapturedInput, operations: ProposalOperation[]) {
  const byId = new Map(operations.map((op) => [op.id, op]));
  const closures = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const closure = (opId: string): Set<string> => {
    const known = closures.get(opId);
    if (known) return known;
    if (visiting.has(opId)) return bad("CYCLE");
    visiting.add(opId);
    const all = new Set<string>();
    for (const dep of byId.get(opId)!.dependsOn) { all.add(dep); for (const inner of closure(dep)) all.add(inner); }
    visiting.delete(opId);
    closures.set(opId, all);
    return all;
  };
  operations.forEach((op) => closure(op.id));

  const created = new Map<string, { op: string; kind: "flow" | "node" }>();
  for (const op of operations) {
    const { edit } = op;
    if (edit.command === "CREATE_FLOW" || edit.command === "ADD_NODE") {
      if (created.has(edit.payload.ref)) bad("DUPLICATE_REF");
      created.set(edit.payload.ref, { op: op.id, kind: edit.command === "CREATE_FLOW" ? "flow" : "node" });
    }
  }
  const generate = capture.taskType === "PROPOSE_FLOW";
  const scopeFlow = capture.selection?.flowId;
  const selected = new Set(capture.selection?.nodeIds ?? []);
  const boundary = new Set(capture.graph.boundaryNodeIds);
  const edges = new Map(capture.graph.edges.map((edge) => [edge.id, edge]));
  const capturedNodes = new Set(capture.graph.nodes.map((node) => node.id));

  /** A reference must be a captured id the task may touch, or a local ref created by an operation this one transitively depends on. */
  const resolveRef = (op: ProposalOperation, value: string, kind: "flow" | "node", allowed: ReadonlySet<string>): string => {
    if (LOCAL_REF.test(value)) {
      const origin = created.get(value);
      return origin && origin.kind === kind && closure(op.id).has(origin.op) ? value : bad("REFERENCE");
    }
    return allowed.has(value) ? value : bad("OUT_OF_SCOPE");
  };
  /** Updates and deletions name only captured, selected steps; a step this same proposal creates is never edited or deleted by it. */
  const captured = (value: string, allowed: ReadonlySet<string>): string => (allowed.has(value) ? value : bad("OUT_OF_SCOPE"));
  const flows = new Set(generate || !scopeFlow ? [] : [scopeFlow]);
  const endpoints = new Set([...selected, ...boundary]);
  const touchedEdges = new Set<string>(), touchedNodes = new Set<string>(), deleted = new Set<string>(), ends: Array<[string, string]> = [];
  let flowCount = 0, nodeCount = 0, edgeCount = 0;
  const touchEdge = (edgeId: string) => { if (touchedEdges.has(edgeId)) bad("CONFLICT"); touchedEdges.add(edgeId); };
  const touchNode = (nodeId: string) => { if (touchedNodes.has(nodeId)) bad("CONFLICT"); touchedNodes.add(nodeId); };
  const edgeEnds = (op: ProposalOperation, fromId: string, toId: string) => {
    const from = resolveRef(op, fromId, "node", endpoints), to = resolveRef(op, toId, "node", endpoints);
    if (boundary.has(from) && boundary.has(to)) bad("OUT_OF_SCOPE"); // an edge between two read-only neighbours is outside the selection
    ends.push([from, to]);
  };
  const generated = [...created].find(([, origin]) => origin.kind === "flow")?.[0] ?? null; // Generate's one new flow
  for (const op of operations) {
    const { edit } = op;
    switch (edit.command) {
      case "CREATE_FLOW": flowCount += 1; break;
      case "ADD_NODE": {
        nodeCount += 1;
        const flowId = resolveRef(op, edit.payload.flowId, "flow", flows);
        if (generate && flowId !== generated) bad("OUT_OF_SCOPE");
        break;
      }
      case "ADD_EDGE": {
        edgeCount += 1;
        const flowId = resolveRef(op, edit.payload.flowId, "flow", flows);
        if (generate && flowId !== generated) bad("OUT_OF_SCOPE");
        edgeEnds(op, edit.payload.fromId, edit.payload.toId);
        break;
      }
      case "UPDATE_NODE": touchNode(captured(edit.payload.nodeId, selected)); break;
      case "DELETE_NODES": {
        resolveRef(op, edit.payload.flowId, "flow", flows);
        const nodeIds = edit.payload.nodeIds.map((nodeId) => captured(nodeId, selected));
        const incident = capture.graph.edges.filter((edge) => nodeIds.includes(edge.fromId) || nodeIds.includes(edge.toId)).map((edge) => edge.id);
        if (!sameSet(incident, edit.payload.removeEdgeIds)) bad("INCOMPLETE_DELETE"); // every incident edge, no more and no fewer
        nodeIds.forEach((nodeId) => { touchNode(nodeId); deleted.add(nodeId); });
        incident.forEach(touchEdge);
        break;
      }
      case "UPDATE_EDGE": case "DELETE_EDGE": case "RECONNECT_EDGE": {
        if (!edges.has(edit.payload.edgeId)) bad("OUT_OF_SCOPE");
        touchEdge(edit.payload.edgeId);
        if (edit.command === "RECONNECT_EDGE") edgeEnds(op, edit.payload.fromId, edit.payload.toId);
        break;
      }
    }
  }
  // Capture ids are only ever the captured graph's; an edge never ends at a node the same proposal deletes.
  if (ends.some(([from, to]) => deleted.has(from) || deleted.has(to))) bad("CONFLICT");
  if (generate && flowCount !== 1) bad("FLOW_GROUP");
  if (nodeCount > capture.limits.maxGraphNodes || edgeCount > capture.limits.maxGraphEdges) bad("GRAPH_LIMIT");
  if (generate && (capturedNodes.size + nodeCount > LIMITS.nodes || capture.graph.edges.length + edgeCount > LIMITS.edges || capture.graph.flows.length + flowCount > LIMITS.flows)) bad("DOCUMENT_LIMIT");
}

function parseCitations(capture: CapturedInput, raw: unknown): SourceRef[] {
  if (!Array.isArray(raw) || raw.length > AI_LIMITS.citations) return bad("CITATIONS");
  const sources = new Map(capture.sources.map((source) => [source.sourceVersionId, source]));
  return raw.map((entry) => {
    const citation = object(entry);
    keys(citation, ["sourceVersionId", "startLine", "endLine", "excerpt"]);
    const source = sources.get(id(citation.sourceVersionId));
    const { startLine, endLine } = citation;
    if (!source) return bad("CITATION_SOURCE");
    const lines = source.text.split("\n");
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || (startLine as number) < 1 || (endLine as number) < (startLine as number) || (endLine as number) > lines.length) return bad("CITATION_RANGE");
    const excerpt = text(citation.excerpt, AI_LIMITS.excerptCodePoints, true);
    if (!lines.slice((startLine as number) - 1, endLine as number).join("\n").includes(excerpt)) return bad("CITATION_EXCERPT");
    return { sourceVersionId: source.sourceVersionId, startLine: startLine as number, endLine: endLine as number, excerpt };
  });
}

function validate(capture: CapturedInput, output: unknown): ValidatedProposal {
  if (jsonbTextBytes(output) > capture.limits.resultBytes) bad("RESULT_BYTES"); // measured as PostgreSQL stores it, so a stored result never fails its CHECK
  const root = object(output);
  if (root.schemaVersion !== 1) bad("SCHEMA_VERSION");
  if (root.kind === "clarification") {
    keys(root, ["schemaVersion", "kind", "message"]);
    return { schemaVersion: 1, kind: "clarification", message: text(root.message, AI_LIMITS.assumptionCodePoints, true) };
  }
  if (root.kind !== "proposal") return bad("KIND");
  keys(root, ["schemaVersion", "kind", "operations", "assumptions", "citations"]);
  const operations = parseOperations(capture, root.operations);
  if (operations.length) checkScope(capture, operations);
  if (!Array.isArray(root.assumptions) || root.assumptions.length > AI_LIMITS.assumptions) bad("ASSUMPTIONS");
  const assumptions = (root.assumptions as unknown[]).map((note) => text(note, AI_LIMITS.assumptionCodePoints, true));
  const citations = parseCitations(capture, root.citations);
  // Only after the whole closed envelope validated: Improve with nothing to change is a no-change clarification.
  if (!operations.length) return capture.taskType === "REFINE_FLOW_SELECTION" ? NO_CHANGE : bad("EMPTY_PROPOSAL");
  return { schemaVersion: 1, kind: "proposal", operations, assumptions, citations };
}

/**
 * Pure and total: returns the normalized, closed result or throws ResultError. Nothing the model returns reaches SUCCEEDED/AVAILABLE
 * without passing here: closed envelope, bounded sizes, same-capture ids only, the task's permitted edits and selection/boundary,
 * complete endpoint and deletion dependencies, acyclic `dependsOn`, and citations that match the captured source text exactly.
 */
export function validateResult(capture: CapturedInput, output: unknown): ValidatedProposal {
  try {
    return validate(capture, output);
  } catch (error) {
    throw error instanceof ResultError ? error : new ResultError("SHAPE");
  }
}
