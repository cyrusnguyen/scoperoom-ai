import { LAYOUT_BYTE_LIMIT, parseLayout, type DraftLayout } from "./draft-layout.ts";
import { id, invalid, keys, object, oneOf, records, text, utf8Bytes, version } from "./strict.ts";

// ScopeDocument storage schema v3 (Data02). Stage 03 activates flows, nodes and edges only: the other collections
// must stay empty, and confirmation, verification and source references stay unset, until the stages whose
// validators own them (07–09) widen this parser.
export const NODE_KINDS = ["START", "ACTION", "DECISION", "OUTCOME", "DATA_STORE"] as const;
export const CLASSIFICATIONS = ["USER_JOURNEY", "BUSINESS_PROCESS"] as const;
export const INCLUSIONS = ["INCLUDED", "EXCLUDED", "UNDECIDED"] as const;
export const ORIGINS = ["HUMAN", "AI_EXTRACTED", "AI_SUGGESTED", "IMPORTED"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Inclusion = (typeof INCLUSIONS)[number];
export type Origin = (typeof ORIGINS)[number];

export const LIMITS = {
  flows: 5, nodes: 200, edges: 400, documentBytes: 2 * 1024 * 1024, layoutBytes: LAYOUT_BYTE_LIMIT,
  title: 120, label: 160, actorLabel: 100, condition: 240, longText: 4_000, notes: 20, note: 500, projectGoal: 8_000,
} as const;

export type FlowRecord = {
  id: string; version: number; behaviourVersion: number; title: string; purpose: string;
  classification: Classification; inclusion: Inclusion; confirmation: null; verificationMethod: null;
};
export type NodeRecord = {
  id: string; flowId: string; version: number; behaviourVersion: number; kind: NodeKind; label: string; description: string;
  actorLabel: string; origin: Origin; sourceRefs: []; assumptionNotes: string[];
};
export type EdgeRecord = { id: string; flowId: string; version: number; fromId: string; toId: string; condition: string; origin: Origin; sourceRefs: [] };

const LATER = ["requirements", "traceLinks", "scenarios", "questions", "decisions", "dependencies", "waivers"] as const;
export type ScopeDocument = {
  schemaVersion: 3; projectGoal: string;
  flows: Record<string, FlowRecord>; nodes: Record<string, NodeRecord>; edges: Record<string, EdgeRecord>;
  retiredEntityIds: string[];
} & Record<(typeof LATER)[number], Record<string, never>>;

/** A coherent saved revision pair, as `GET D` and the project bootstrap return it. */
export type DraftView = { id: string; status: "EDITABLE" | "ARCHIVED"; documentRevision: number; layoutRevision: number; document: ScopeDocument; layout: DraftLayout };

function none(value: unknown): [] {
  if (!Array.isArray(value) || value.length) invalid();
  return [];
}

function parseFlow(entry: unknown): FlowRecord {
  const flow = object(entry);
  keys(flow, ["id", "version", "behaviourVersion", "title", "purpose", "classification", "inclusion", "confirmation", "verificationMethod"]);
  if (flow.confirmation !== null || flow.verificationMethod !== null) invalid();
  return {
    id: id(flow.id), version: version(flow.version), behaviourVersion: version(flow.behaviourVersion), title: text(flow.title, LIMITS.title, true),
    purpose: text(flow.purpose, LIMITS.longText), classification: oneOf(flow.classification, CLASSIFICATIONS), inclusion: oneOf(flow.inclusion, INCLUSIONS),
    confirmation: null, verificationMethod: null,
  };
}

function parseNode(entry: unknown): NodeRecord {
  const node = object(entry);
  keys(node, ["id", "flowId", "version", "behaviourVersion", "kind", "label", "description", "actorLabel", "origin", "sourceRefs", "assumptionNotes"]);
  if (!Array.isArray(node.assumptionNotes) || node.assumptionNotes.length > LIMITS.notes) invalid();
  return {
    id: id(node.id), flowId: id(node.flowId), version: version(node.version), behaviourVersion: version(node.behaviourVersion), kind: oneOf(node.kind, NODE_KINDS),
    label: text(node.label, LIMITS.label, true), description: text(node.description, LIMITS.longText), actorLabel: text(node.actorLabel, LIMITS.actorLabel),
    origin: oneOf(node.origin, ORIGINS), sourceRefs: none(node.sourceRefs), assumptionNotes: node.assumptionNotes.map((note) => text(note, LIMITS.note, true)),
  };
}

function parseEdge(entry: unknown): EdgeRecord {
  const edge = object(entry);
  keys(edge, ["id", "flowId", "version", "fromId", "toId", "condition", "origin", "sourceRefs"]);
  return {
    id: id(edge.id), flowId: id(edge.flowId), version: version(edge.version), fromId: id(edge.fromId), toId: id(edge.toId),
    condition: text(edge.condition, LIMITS.condition), origin: oneOf(edge.origin, ORIGINS), sourceRefs: none(edge.sourceRefs),
  };
}

export function parseDocument(value: unknown): ScopeDocument {
  const document = object(value);
  keys(document, ["schemaVersion", "projectGoal", "flows", "nodes", "edges", ...LATER, "retiredEntityIds"]);
  if (document.schemaVersion !== 3) invalid();
  const flows = records(document.flows, LIMITS.flows, parseFlow);
  const nodes = records(document.nodes, LIMITS.nodes, parseNode);
  const edges = records(document.edges, LIMITS.edges, parseEdge);
  // Every node sits in an existing flow; every edge and both of its endpoints sit in one flow.
  for (const node of Object.values(nodes)) if (!flows[node.flowId]) invalid();
  for (const edge of Object.values(edges)) {
    if (!flows[edge.flowId] || nodes[edge.fromId]?.flowId !== edge.flowId || nodes[edge.toId]?.flowId !== edge.flowId) invalid();
  }
  const active = [...Object.keys(flows), ...Object.keys(nodes), ...Object.keys(edges)];
  const activeIds = new Set(active);
  if (activeIds.size !== active.length) invalid();
  for (const name of LATER) if (Object.keys(object(document[name])).length) invalid();
  if (!Array.isArray(document.retiredEntityIds)) invalid();
  const retiredEntityIds = document.retiredEntityIds.map(id);
  // Sorted and distinct, and no retired id is active again.
  if (retiredEntityIds.some((retired, index) => (index > 0 && retiredEntityIds[index - 1]! >= retired) || activeIds.has(retired))) invalid();
  return {
    schemaVersion: 3, projectGoal: text(document.projectGoal, LIMITS.projectGoal), flows, nodes, edges,
    requirements: {}, traceLinks: {}, scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {}, retiredEntityIds,
  };
}

/** Validates a document and its layout together, within their byte caps. Throws INVALID_INPUT on any violation. */
export function parseDraftPair(document: unknown, layout: unknown): { document: ScopeDocument; layout: DraftLayout } {
  if (utf8Bytes(document) > LIMITS.documentBytes || utf8Bytes(layout) > LIMITS.layoutBytes) invalid();
  const parsed = parseDocument(document);
  return { document: parsed, layout: parseLayout(layout, new Set(Object.keys(parsed.nodes)), new Set(Object.keys(parsed.flows)), new Set(Object.keys(parsed.edges))) };
}

/** The one empty-draft factory project creation uses (Data02). */
export function emptyDraft(): { document: ScopeDocument; layout: DraftLayout } {
  return {
    document: {
      schemaVersion: 3, projectGoal: "", flows: {}, nodes: {}, edges: {},
      requirements: {}, traceLinks: {}, scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {}, retiredEntityIds: [],
    },
    layout: { schemaVersion: 1, positions: {}, directions: {}, edgeSides: {} },
  };
}
