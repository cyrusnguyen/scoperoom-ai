import { LAYOUT_BYTE_LIMIT, parseLayout, type DraftLayout } from "./draft-layout.ts";
import { id, idList, invalid, keys, object, oneOf, records, text, utf8Bytes, version } from "./strict.ts";

// ScopeDocument storage schema v3 (Data02). Stage 07 activates requirements and trace links; other collections
// must stay empty, and confirmation and verification stay unset until the stages whose
// validators own them (07–09) widen this parser.
export const NODE_KINDS = ["START", "ACTION", "DECISION", "OUTCOME", "DATA_STORE"] as const;
export const CLASSIFICATIONS = ["USER_JOURNEY", "BUSINESS_PROCESS"] as const;
export const INCLUSIONS = ["INCLUDED", "EXCLUDED", "UNDECIDED"] as const;
export const ORIGINS = ["HUMAN", "AI_EXTRACTED", "AI_SUGGESTED", "IMPORTED"] as const;
export const REQUIREMENT_CATEGORIES = ["FUNCTIONAL", "NON_FUNCTIONAL", "CONSTRAINT"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Inclusion = (typeof INCLUSIONS)[number];
export type Origin = (typeof ORIGINS)[number];
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const LIMITS = {
  flows: 5, nodes: 200, edges: 400, requirements: 150, traceLinks: 400, documentBytes: 2 * 1024 * 1024, layoutBytes: LAYOUT_BYTE_LIMIT,
  role: 120,
  title: 120, label: 160, actorLabel: 100, condition: 240, longText: 4_000, notes: 20, note: 500, projectGoal: 8_000,
} as const;

export type FlowRecord = {
  id: string; version: number; behaviourVersion: number; title: string; purpose: string;
  classification: Classification; inclusion: Inclusion; confirmation: null; verificationMethod: null;
};
export type NodeRecord = {
  id: string; flowId: string; version: number; behaviourVersion: number; kind: NodeKind; label: string; description: string;
  actorLabel: string; origin: Origin; sourceRefs: SourceRef[]; assumptionNotes: string[];
};
export type EdgeRecord = { id: string; flowId: string; version: number; fromId: string; toId: string; condition: string; origin: Origin; sourceRefs: SourceRef[] };
export type ConfirmationStamp = { behaviourVersion: number; actorId: string; confirmedAt: string } | null;
export type VerificationMethod = { description: string; responsibleRole: string; reviewedBehaviourVersion: number | null; reviewedBy: string | null; reviewedAt: string | null } | null;
export type RequirementRecord = {
  id: string; displayId: string; version: number; behaviourVersion: number; title: string; statement: string;
  category: RequirementCategory; inclusion: Inclusion; origin: Origin; sourceRefs: SourceRef[]; decisionIds: string[];
  ownerId: string | null; confirmation: ConfirmationStamp; verificationMethod: VerificationMethod;
};
export type TraceLinkRecord = {
  id: string; version: number; requirementId: string; nodeId: string; explanation: string;
  reviewedRequirementBehaviourVersion: number | null; reviewedNodeBehaviourVersion: number | null; reviewedBy: string | null; reviewedAt: string | null;
};

const LATER = ["scenarios", "questions", "decisions", "dependencies", "waivers"] as const;
export type ScopeDocument = {
  schemaVersion: 3; projectGoal: string;
  flows: Record<string, FlowRecord>; nodes: Record<string, NodeRecord>; edges: Record<string, EdgeRecord>;
  requirements: Record<string, RequirementRecord>; traceLinks: Record<string, TraceLinkRecord>;
  retiredEntityIds: string[];
} & Record<(typeof LATER)[number], Record<string, never>>;

/** A coherent saved revision pair, as `GET D` and the project bootstrap return it. */
export type DraftView = { id: string; status: "EDITABLE" | "ARCHIVED"; documentRevision: number; layoutRevision: number; document: ScopeDocument; layout: DraftLayout };

export type SourceRef = { sourceVersionId: string; startLine: number; endLine: number; excerpt: string };
export const SOURCE_REF_LIMITS = { count: 100, excerpt: 2_000 } as const;

/** Structure only: project/source ownership and exact excerpt matching are checked against captured SQL evidence. */
export function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value) || value.length > SOURCE_REF_LIMITS.count) invalid();
  const refs = value.map(entry => {
    const ref = object(entry);
    keys(ref, ["sourceVersionId", "startLine", "endLine", "excerpt"]);
    if (!Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine) || (ref.startLine as number) < 1 || (ref.endLine as number) < (ref.startLine as number)) invalid();
    return { sourceVersionId: id(ref.sourceVersionId), startLine: ref.startLine as number, endLine: ref.endLine as number, excerpt: text(ref.excerpt, SOURCE_REF_LIMITS.excerpt, true) };
  });
  if (new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length) invalid();
  return refs;
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
    origin: oneOf(node.origin, ORIGINS), sourceRefs: parseSourceRefs(node.sourceRefs), assumptionNotes: node.assumptionNotes.map((note) => text(note, LIMITS.note, true)),
  };
}

function parseEdge(entry: unknown): EdgeRecord {
  const edge = object(entry);
  keys(edge, ["id", "flowId", "version", "fromId", "toId", "condition", "origin", "sourceRefs"]);
  return {
    id: id(edge.id), flowId: id(edge.flowId), version: version(edge.version), fromId: id(edge.fromId), toId: id(edge.toId),
    condition: text(edge.condition, LIMITS.condition), origin: oneOf(edge.origin, ORIGINS), sourceRefs: parseSourceRefs(edge.sourceRefs),
  };
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function parseTime(value: unknown): string {
  if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
const DISPLAY_ID = /^REQ-\d{3,9}$/;
const nullableVersion = (value: unknown) => (value === null ? null : version(value));
const nullableId = (value: unknown) => (value === null ? null : id(value));

function parseConfirmation(value: unknown): ConfirmationStamp {
  if (value === null) return null;
  const stamp = object(value);
  keys(stamp, ["behaviourVersion", "actorId", "confirmedAt"]);
  return { behaviourVersion: version(stamp.behaviourVersion), actorId: id(stamp.actorId), confirmedAt: parseTime(stamp.confirmedAt) };
}

function parseVerification(value: unknown): VerificationMethod {
  if (value === null) return null;
  const method = object(value);
  keys(method, ["description", "responsibleRole", "reviewedBehaviourVersion", "reviewedBy", "reviewedAt"]);
  const review = [method.reviewedBehaviourVersion, method.reviewedBy, method.reviewedAt];
  if (review.some((entry) => entry === null) && review.some((entry) => entry !== null)) invalid();
  return {
    description: text(method.description, LIMITS.longText, true), responsibleRole: text(method.responsibleRole, LIMITS.role, true),
    reviewedBehaviourVersion: nullableVersion(method.reviewedBehaviourVersion), reviewedBy: nullableId(method.reviewedBy),
    reviewedAt: method.reviewedAt === null ? null : parseTime(method.reviewedAt),
  };
}

function parseRequirement(entry: unknown): RequirementRecord {
  const requirement = object(entry);
  keys(requirement, ["id", "displayId", "version", "behaviourVersion", "title", "statement", "category", "inclusion", "origin", "sourceRefs", "decisionIds", "ownerId", "confirmation", "verificationMethod"]);
  if (typeof requirement.displayId !== "string" || !DISPLAY_ID.test(requirement.displayId)) invalid();
  return {
    id: id(requirement.id), displayId: requirement.displayId, version: version(requirement.version), behaviourVersion: version(requirement.behaviourVersion),
    title: text(requirement.title, LIMITS.title, true), statement: text(requirement.statement, LIMITS.longText), category: oneOf(requirement.category, REQUIREMENT_CATEGORIES),
    inclusion: oneOf(requirement.inclusion, INCLUSIONS), origin: oneOf(requirement.origin, ORIGINS), sourceRefs: parseSourceRefs(requirement.sourceRefs),
    decisionIds: idList(requirement.decisionIds, 200), ownerId: nullableId(requirement.ownerId),
    confirmation: parseConfirmation(requirement.confirmation), verificationMethod: parseVerification(requirement.verificationMethod),
  };
}

function parseTraceLink(entry: unknown): TraceLinkRecord {
  const link = object(entry);
  keys(link, ["id", "version", "requirementId", "nodeId", "explanation", "reviewedRequirementBehaviourVersion", "reviewedNodeBehaviourVersion", "reviewedBy", "reviewedAt"]);
  const review = [link.reviewedRequirementBehaviourVersion, link.reviewedNodeBehaviourVersion, link.reviewedBy, link.reviewedAt];
  if (review.some((entry) => entry === null) && review.some((entry) => entry !== null)) invalid();
  return {
    id: id(link.id), version: version(link.version), requirementId: id(link.requirementId), nodeId: id(link.nodeId), explanation: text(link.explanation, LIMITS.longText),
    reviewedRequirementBehaviourVersion: nullableVersion(link.reviewedRequirementBehaviourVersion), reviewedNodeBehaviourVersion: nullableVersion(link.reviewedNodeBehaviourVersion),
    reviewedBy: nullableId(link.reviewedBy), reviewedAt: link.reviewedAt === null ? null : parseTime(link.reviewedAt),
  };
}

export function parseDocument(value: unknown): ScopeDocument {
  const document = object(value);
  keys(document, ["schemaVersion", "projectGoal", "flows", "nodes", "edges", "requirements", "traceLinks", ...LATER, "retiredEntityIds"]);
  if (document.schemaVersion !== 3) invalid();
  const flows = records(document.flows, LIMITS.flows, parseFlow);
  const nodes = records(document.nodes, LIMITS.nodes, parseNode);
  const edges = records(document.edges, LIMITS.edges, parseEdge);
  // Every node sits in an existing flow; every edge and both of its endpoints sit in one flow.
  for (const node of Object.values(nodes)) if (!flows[node.flowId]) invalid();
  for (const edge of Object.values(edges)) {
    if (!flows[edge.flowId] || nodes[edge.fromId]?.flowId !== edge.flowId || nodes[edge.toId]?.flowId !== edge.flowId) invalid();
  }
  const requirements = records(document.requirements, LIMITS.requirements, parseRequirement);
  const traceLinks = records(document.traceLinks, LIMITS.traceLinks, parseTraceLink);
  const decisions = object(document.decisions);
  if (new Set(Object.values(requirements).map((entry) => entry.displayId)).size !== Object.keys(requirements).length) invalid();
  for (const requirement of Object.values(requirements)) if (requirement.decisionIds.some((decisionId) => !Object.hasOwn(decisions, decisionId))) invalid();
  const pairs = new Set<string>();
  for (const link of Object.values(traceLinks)) {
    const pair = `${link.requirementId}:${link.nodeId}`;
    if (!requirements[link.requirementId] || !nodes[link.nodeId] || pairs.has(pair)) invalid();
    pairs.add(pair);
  }
  const active = [...Object.keys(flows), ...Object.keys(nodes), ...Object.keys(edges), ...Object.keys(requirements), ...Object.keys(traceLinks)];
  const activeIds = new Set(active);
  if (activeIds.size !== active.length) invalid();
  for (const name of LATER) if (Object.keys(object(document[name])).length) invalid();
  if (!Array.isArray(document.retiredEntityIds)) invalid();
  const retiredEntityIds = document.retiredEntityIds.map(id);
  // Sorted and distinct, and no retired id is active again.
  if (retiredEntityIds.some((retired, index) => (index > 0 && retiredEntityIds[index - 1]! >= retired) || activeIds.has(retired))) invalid();
  return {
    schemaVersion: 3, projectGoal: text(document.projectGoal, LIMITS.projectGoal), flows, nodes, edges,
    requirements, traceLinks, scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {}, retiredEntityIds,
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
