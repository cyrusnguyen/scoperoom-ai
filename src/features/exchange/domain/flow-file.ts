import { coordinate, DIRECTIONS, SIDES } from "../../drafts/contracts/draft-layout.ts";
import { CLASSIFICATIONS, INCLUSIONS, LIMITS, NODE_KINDS } from "../../drafts/contracts/scope-document.ts";
import { id, invalid, keys, object, oneOf, text, version } from "../../drafts/contracts/strict.ts";
import type { FlowFileEdge, FlowFileEdgeSides, FlowFileLinkHint, FlowFileNode, FlowFileOrigin, FlowFilePosition, FlowFileV1 } from "../contracts/flow-file.ts";

export const FLOW_FILE_BYTE_LIMIT = 1_048_576;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);
const SHA_256 = /^[a-f0-9]{64}$/;

function fileId(value: unknown): string {
  if (typeof value !== "string" || !FILE_ID.test(value) || DANGEROUS.has(value)) invalid();
  return value;
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null;
  const parsed = text(value, max);
  return parsed === "" ? null : parsed;
}

function scanNesting(json: string) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 20) invalid();
    } else if (character === "}" || character === "]") depth -= 1;
  }
}

function rejectDangerousKeys(value: unknown) {
  if (Array.isArray(value)) {
    for (const entry of value) rejectDangerousKeys(entry);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS.has(key)) invalid();
      rejectDangerousKeys(entry);
    }
  }
}

function parseFlow(value: unknown): FlowFileV1["flow"] {
  const flow = object(value);
  keys(flow, ["title", "purpose", "classification", "direction"]);
  return {
    title: text(flow.title, LIMITS.title, true), purpose: text(flow.purpose, LIMITS.longText),
    classification: oneOf(flow.classification, CLASSIFICATIONS), direction: oneOf(flow.direction, DIRECTIONS),
  };
}

function parseNode(value: unknown): FlowFileNode {
  const node = object(value);
  keys(node, ["id", "kind", "label", "description", "actorLabel", "assumptionNotes"]);
  if (!Array.isArray(node.assumptionNotes) || node.assumptionNotes.length > LIMITS.notes) invalid();
  return {
    id: fileId(node.id), kind: oneOf(node.kind, NODE_KINDS), label: text(node.label, LIMITS.label, true),
    description: text(node.description, LIMITS.longText), actorLabel: nullableText(node.actorLabel, LIMITS.actorLabel),
    assumptionNotes: node.assumptionNotes.map(note => text(note, LIMITS.note, true)),
  };
}

function parseEdge(value: unknown): FlowFileEdge {
  const edge = object(value);
  keys(edge, ["id", "fromId", "toId", "condition"]);
  return { id: fileId(edge.id), fromId: fileId(edge.fromId), toId: fileId(edge.toId), condition: nullableText(edge.condition, LIMITS.condition) };
}

function parseOrigin(value: unknown): FlowFileOrigin {
  const origin = object(value);
  if (origin.kind === "DRAFT") {
    keys(origin, ["kind", "documentRevision", "layoutRevision"]);
    return { kind: "DRAFT", documentRevision: version(origin.documentRevision), layoutRevision: version(origin.layoutRevision) };
  }
  keys(origin, ["kind", "documentRevision", "layoutRevision", "sourceInclusion"], ["snapshotId", "contentHash", "reviewHash"]);
  if (origin.kind !== "SNAPSHOT") invalid();
  const parsed: FlowFileOrigin = {
    kind: "SNAPSHOT", documentRevision: version(origin.documentRevision), layoutRevision: version(origin.layoutRevision),
    sourceInclusion: oneOf(origin.sourceInclusion, INCLUSIONS),
  };
  if (Object.hasOwn(origin, "snapshotId")) parsed.snapshotId = id(origin.snapshotId);
  for (const field of ["contentHash", "reviewHash"] as const) if (Object.hasOwn(origin, field)) {
    if (typeof origin[field] !== "string" || !SHA_256.test(origin[field])) invalid();
    parsed[field] = origin[field];
  }
  return parsed;
}

function parsePositions(value: unknown, nodeIds: ReadonlySet<string>): FlowFilePosition[] {
  if (!Array.isArray(value) || value.length !== nodeIds.size) invalid();
  const seen = new Set<string>();
  return value.map(entry => {
    const position = object(entry);
    keys(position, ["nodeId", "x", "y"]);
    const nodeId = fileId(position.nodeId);
    if (!nodeIds.has(nodeId) || seen.has(nodeId)) invalid();
    seen.add(nodeId);
    return { nodeId, x: coordinate(position.x), y: coordinate(position.y) };
  });
}

function parseEdgeSides(value: unknown, edgeIds: ReadonlySet<string>): FlowFileEdgeSides[] {
  if (!Array.isArray(value) || value.length > edgeIds.size) invalid();
  const seen = new Set<string>();
  return value.map(entry => {
    const sides = object(entry);
    keys(sides, ["edgeId", "from", "to"]);
    const edgeId = fileId(sides.edgeId);
    if (!edgeIds.has(edgeId) || seen.has(edgeId)) invalid();
    seen.add(edgeId);
    return { edgeId, from: oneOf(sides.from, SIDES), to: oneOf(sides.to, SIDES) };
  });
}

function parseHints(value: unknown, nodeIds: ReadonlySet<string>): FlowFileLinkHint[] {
  if (!Array.isArray(value) || value.length > LIMITS.edges) invalid();
  return value.map(entry => {
    const hint = object(entry);
    keys(hint, ["nodeId", "requirementId", "requirementTitle"]);
    const nodeId = fileId(hint.nodeId);
    if (!nodeIds.has(nodeId)) invalid();
    return { nodeId, requirementId: text(hint.requirementId, 120, true), requirementTitle: text(hint.requirementTitle, 120, true) };
  });
}

function parseFile(value: unknown): FlowFileV1 {
  const file = object(value);
  keys(file, ["format", "formatVersion", "exportedAt", "producerVersion", "flow", "nodes", "edges", "origin"], ["positions", "edgeSides", "viewport", "linkHints"]);
  if (file.format !== "scoperoom-flow" || file.formatVersion !== 1 || typeof file.exportedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(file.exportedAt) || Number.isNaN(Date.parse(file.exportedAt))) invalid();
  if (!Array.isArray(file.nodes) || file.nodes.length > LIMITS.nodes || !Array.isArray(file.edges) || file.edges.length > LIMITS.edges) invalid();
  const nodes = file.nodes.map(parseNode);
  const edges = file.edges.map(parseEdge);
  const ids = new Set<string>();
  for (const entry of [...nodes, ...edges]) if (ids.has(entry.id)) invalid(); else ids.add(entry.id);
  const nodeIds = new Set(nodes.map(node => node.id));
  for (const edge of edges) if (!nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId)) invalid();
  const result: FlowFileV1 = {
    format: "scoperoom-flow", formatVersion: 1, exportedAt: file.exportedAt, producerVersion: text(file.producerVersion, 120, true),
    flow: parseFlow(file.flow), nodes, edges, origin: parseOrigin(file.origin),
  };
  if (Object.hasOwn(file, "positions")) result.positions = parsePositions(file.positions, nodeIds);
  if (Object.hasOwn(file, "edgeSides")) result.edgeSides = parseEdgeSides(file.edgeSides, new Set(edges.map(edge => edge.id)));
  if (Object.hasOwn(file, "viewport")) {
    const viewport = object(file.viewport);
    keys(viewport, ["x", "y", "zoom"]);
    if (typeof viewport.zoom !== "number" || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || viewport.zoom > 100) invalid();
    result.viewport = { x: coordinate(viewport.x), y: coordinate(viewport.y), zoom: viewport.zoom };
  }
  if (Object.hasOwn(file, "linkHints")) result.linkHints = parseHints(file.linkHints, nodeIds);
  return result;
}

export function parseFlowFile(bytes: Uint8Array): FlowFileV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > FLOW_FILE_BYTE_LIMIT) invalid();
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid(); }
  scanNesting(json);
  let value: unknown;
  try { value = JSON.parse(json); } catch { return invalid(); }
  rejectDangerousKeys(value);
  return parseFile(value);
}

export function serializeFlowFile(file: FlowFileV1): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(parseFile(file)));
  if (encoded.byteLength > FLOW_FILE_BYTE_LIMIT) invalid();
  return encoded;
}
