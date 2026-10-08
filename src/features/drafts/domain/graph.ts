import type { GraphCommand } from "../contracts/commands.ts";
import { COORDINATE_LIMIT, type DraftLayout, type SavedPosition } from "../contracts/draft-layout.ts";
import { LIMITS, parseDraftPair, type ScopeDocument, type SourceRef } from "../contracts/scope-document.ts";
import { MAX_VERSION, utf8Bytes } from "../contracts/strict.ts";

// Pure graph transforms (Data02 version matrix, Data03 command families). The server applies them to its locked
// saved draft, and the browser reuses dependencyPlan to show exactly what a deletion will remove.
export type GraphErrorCode =
  | "INVALID_INPUT"
  | "STALE_ENTITY_VERSION"
  | "STALE_DOCUMENT_REVISION"
  | "DEPENDENCY_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "VERSION_EXHAUSTED"
  | "POSITION_CONFLICT"
  | "STALE_LAYOUT_REVISION"
  | "ARRANGEMENT_PREVIEW_CHANGED";
export type GraphErrorDetails = Record<string, string | number | null>;

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly details?: GraphErrorDetails;

  constructor(code: GraphErrorCode, details?: GraphErrorDetails) {
    super(code);
    this.name = "GraphError";
    this.code = code;
    this.details = details;
  }
}

export type Draft = { document: ScopeDocument; layout: DraftLayout };
export type Applied = Draft & {
  documentChanged: boolean;
  layoutChanged: boolean;
  createdIds: string[];
  versions: Record<string, number>;
  retiredIds: string[];
};

function fail(code: GraphErrorCode, details?: GraphErrorDetails): never {
  throw new GraphError(code, details);
}

/** Deterministic record order: stored JSONB sorts keys, a browser copy keeps insertion order. */
export const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function bump(value: number): number {
  if (value >= MAX_VERSION) fail("VERSION_EXHAUSTED");
  return value + 1;
}

/** What deleting these nodes (or, without nodeIds, the whole flow's nodes) removes, sorted. */
export function dependencyPlan(
  document: ScopeDocument,
  flowId: string,
  nodeIds?: string[],
): { nodeIds: string[]; edgeIds: string[] } {
  const ids = nodeIds ?? Object.values(document.nodes)
    .filter((node) => node.flowId === flowId)
    .map((node) => node.id);
  const removing = new Set(ids);
  const edgeIds = Object.values(document.edges)
    .filter((edge) => removing.has(edge.fromId) || removing.has(edge.toId))
    .map((edge) => edge.id);
  return { nodeIds: [...ids].sort(), edgeIds: edgeIds.sort() };
}

const sameIds = (planned: string[], requested: string[]) => JSON.stringify(planned) === JSON.stringify([...requested].sort());

/** New nodes go after the flow's last node along its direction; existing positions never move. */
function placeNew(document: ScopeDocument, layout: DraftLayout, flowId: string): SavedPosition {
  const siblings = Object.values(document.nodes)
    .filter((node) => node.flowId === flowId)
    .map((node) => layout.positions[node.id]!);
  if (!siblings.length) return { x: 0, y: 0, version: 1 };
  const xs = siblings.map((position) => position.x);
  const ys = siblings.map((position) => position.y);
  return layout.directions[flowId] === "LR"
    ? { x: Math.min(Math.max(...xs) + 260, COORDINATE_LIMIT), y: Math.min(...ys), version: 1 }
    : { x: Math.min(...xs), y: Math.min(Math.max(...ys) + 160, COORDINATE_LIMIT), version: 1 };
}

function unchanged(record: Record<string, unknown>, fields: Record<string, unknown>) {
  return Object.entries(fields).every(([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value));
}

export function current<T extends { version: number }>(record: T | undefined, entityId: string, expected: number): T {
  if (!record || record.version !== expected) {
    fail("STALE_ENTITY_VERSION", { entityId, currentVersion: record?.version ?? null });
  }
  return record;
}

/** Every id the draft has ever used: active records in any collection plus retired ones. New ids must avoid all of them. */
export function usedIds(document: ScopeDocument): Set<string> {
  return new Set([
    ...Object.keys(document.flows), ...Object.keys(document.nodes), ...Object.keys(document.edges),
    ...Object.keys(document.requirements), ...Object.keys(document.traceLinks), ...document.retiredEntityIds,
  ]);
}

/** Trace links that end at these steps: removed with them in one change (Data02 reference rules). */
export function incidentTraceLinks(document: ScopeDocument, nodeIds: Iterable<string>): string[] {
  const removing = new Set(nodeIds);
  return Object.values(document.traceLinks).filter((link) => removing.has(link.nodeId)).map((link) => link.id).sort();
}

/** The final size and invariant check of a changed draft (LIMIT_EXCEEDED is a refusal; anything else a server fault). */
export function checkDraft({ document, layout }: Draft) {
  if (utf8Bytes(document) > LIMITS.documentBytes || utf8Bytes(layout) > LIMITS.layoutBytes) fail("LIMIT_EXCEEDED");
  try {
    parseDraftPair(document, layout);
  } catch {
    throw new Error("GRAPH_INVARIANT");
  }
}

/**
 * Applies one command to a saved draft and returns the next valid draft. GraphError signals a safe command refusal;
 * other errors represent a server invariant failure. An effective no-op returns documentChanged=false.
 *
 * `inPlace` is for a batch: `saved` is the caller's private working copy, changed in place and not checked here, and
 * the caller runs checkDraft once on the final draft. A refusal can leave the copy half-changed, so any error discards it.
 */
function transformGraphCommand(
  saved: Draft,
  documentRevision: number,
  command: GraphCommand,
  newId: () => string,
  { inPlace = false, deferVersions = false } = {},
): Applied {
  if ("expectedDocumentRevision" in command && command.expectedDocumentRevision !== documentRevision) {
    fail("STALE_DOCUMENT_REVISION", { documentRevision });
  }

  const increment = deferVersions ? (value: number) => value : bump;
  const document = inPlace ? saved.document : structuredClone(saved.document);
  const layout = inPlace ? saved.layout : structuredClone(saved.layout);
  const used = usedIds(document);
  const createdIds: string[] = [];
  const retiredIds: string[] = [];
  const versions: Record<string, number> = {};
  let layoutChanged = false;

  const allocate = () => {
    const value = newId();
    if (used.has(value)) fail("INVALID_INPUT");
    used.add(value);
    createdIds.push(value);
    return value;
  };
  // Node and edge semantics belong to their parent flow. Each applicable command advances it once.
  const touchFlow = (flowId: string) => {
    const flow = document.flows[flowId]!;
    document.flows[flowId] = {
      ...flow,
      version: increment(flow.version),
      behaviourVersion: increment(flow.behaviourVersion),
    };
    versions[flowId] = document.flows[flowId].version;
  };
  const retire = (ids: string[]) => {
    retiredIds.push(...ids);
    document.retiredEntityIds = [...document.retiredEntityIds, ...ids].sort();
  };
  const noChange = (): Applied => ({
    ...saved,
    documentChanged: false,
    layoutChanged: false,
    createdIds: [],
    versions: {},
    retiredIds: [],
  });
  /** A layout-only effect (Task 13's side-only RECONNECT_EDGE): the document is untouched, so no revision or version
   * advances, but the changed layout still needs its own invariant check and its layoutRevision. */
  const layoutOnly = (): Applied => {
    if (!inPlace) checkDraft({ document, layout });
    return { document, layout, documentChanged: false, layoutChanged: true, createdIds: [], versions: {}, retiredIds: [] };
  };

  switch (command.command) {
    case "CREATE_FLOW": {
      if (Object.keys(document.flows).length >= LIMITS.flows) fail("LIMIT_EXCEEDED", { limit: LIMITS.flows });
      const flowId = allocate();
      document.flows[flowId] = {
        id: flowId,
        version: 1,
        behaviourVersion: 1,
        ...command.payload,
        confirmation: null,
        verificationMethod: null,
      };
      layout.directions[flowId] = "TB";
      layoutChanged = true;
      break;
    }
    case "UPDATE_FLOW": {
      const { flowId, ...fields } = command.payload;
      const flow = current(document.flows[flowId], flowId, command.expectedEntityVersion);
      if (unchanged(flow, fields)) return noChange();
      document.flows[flowId] = {
        ...flow,
        ...fields,
        version: increment(flow.version),
        behaviourVersion: increment(flow.behaviourVersion),
      };
      versions[flowId] = document.flows[flowId].version;
      break;
    }
    case "DUPLICATE_FLOW": {
      const source = document.flows[command.payload.flowId] ?? fail("INVALID_INPUT");
      const nodes = Object.values(document.nodes).filter((node) => node.flowId === source.id).sort(byId);
      const edges = Object.values(document.edges).filter((edge) => edge.flowId === source.id).sort(byId);
      const title = `Copy of ${source.title}`;
      if ([...title].length > LIMITS.title) fail("LIMIT_EXCEEDED", { limit: LIMITS.title });
      if (
        Object.keys(document.flows).length >= LIMITS.flows
        || Object.keys(document.nodes).length + nodes.length > LIMITS.nodes
        || Object.keys(document.edges).length + edges.length > LIMITS.edges
      ) fail("LIMIT_EXCEEDED");

      const flowId = allocate();
      document.flows[flowId] = {
        ...source,
        id: flowId,
        version: 1,
        behaviourVersion: 1,
        title,
        confirmation: null,
        verificationMethod: null,
      };
      layout.directions[flowId] = layout.directions[source.id]!;
      const remap = new Map<string, string>();
      for (const node of nodes) {
        const nodeId = allocate();
        remap.set(node.id, nodeId);
        document.nodes[nodeId] = {
          ...node,
          id: nodeId,
          flowId,
          version: 1,
          behaviourVersion: 1,
        };
        const { x, y } = layout.positions[node.id]!;
        layout.positions[nodeId] = { x, y, version: 1 };
      }
      for (const edge of edges) {
        const edgeId = allocate();
        document.edges[edgeId] = {
          ...edge,
          id: edgeId,
          flowId,
          version: 1,
          fromId: remap.get(edge.fromId)!,
          toId: remap.get(edge.toId)!,
        };
        const sides = layout.edgeSides[edge.id];
        if (sides) layout.edgeSides[edgeId] = sides;
      }
      layoutChanged = true;
      break;
    }
    case "DELETE_FLOW": {
      const flow = document.flows[command.payload.flowId] ?? fail("INVALID_INPUT");
      const plan = dependencyPlan(document, flow.id);
      if (!sameIds(plan.nodeIds, command.payload.removeNodeIds) || !sameIds(plan.edgeIds, command.payload.removeEdgeIds)) {
        fail("DEPENDENCY_CONFLICT");
      }
      const linkIds = incidentTraceLinks(document, plan.nodeIds);
      for (const edgeId of plan.edgeIds) { delete document.edges[edgeId]; delete layout.edgeSides[edgeId]; }
      for (const linkId of linkIds) delete document.traceLinks[linkId];
      for (const nodeId of plan.nodeIds) {
        delete document.nodes[nodeId];
        delete layout.positions[nodeId];
      }
      delete document.flows[flow.id];
      delete layout.directions[flow.id];
      retire([flow.id, ...plan.nodeIds, ...plan.edgeIds, ...linkIds]);
      layoutChanged = true;
      break;
    }
    case "ADD_NODE": {
      const { flowId, ...fields } = command.payload;
      if (!document.flows[flowId]) fail("INVALID_INPUT");
      if (Object.keys(document.nodes).length >= LIMITS.nodes) fail("LIMIT_EXCEEDED", { limit: LIMITS.nodes });
      const position = placeNew(document, layout, flowId);
      const nodeId = allocate();
      document.nodes[nodeId] = {
        id: nodeId,
        flowId,
        version: 1,
        behaviourVersion: 1,
        ...fields,
        origin: "HUMAN",
        sourceRefs: [],
        assumptionNotes: [],
      };
      layout.positions[nodeId] = position;
      touchFlow(flowId);
      layoutChanged = true;
      break;
    }
    case "UPDATE_NODE": {
      const { nodeId, ...fields } = command.payload;
      const node = current(document.nodes[nodeId], nodeId, command.expectedEntityVersion);
      if (unchanged(node, fields)) return noChange();
      document.nodes[nodeId] = {
        ...node,
        ...fields,
        version: increment(node.version),
        behaviourVersion: increment(node.behaviourVersion),
      };
      versions[nodeId] = document.nodes[nodeId].version;
      touchFlow(node.flowId);
      break;
    }
    case "DELETE_NODES": {
      const { flowId, nodeIds, removeEdgeIds } = command.payload;
      if (!document.flows[flowId] || nodeIds.some((nodeId) => document.nodes[nodeId]?.flowId !== flowId)) {
        fail("INVALID_INPUT");
      }
      const plan = dependencyPlan(document, flowId, nodeIds);
      if (!sameIds(plan.edgeIds, removeEdgeIds)) fail("DEPENDENCY_CONFLICT");
      const linkIds = incidentTraceLinks(document, plan.nodeIds);
      for (const edgeId of plan.edgeIds) { delete document.edges[edgeId]; delete layout.edgeSides[edgeId]; }
      for (const linkId of linkIds) delete document.traceLinks[linkId];
      for (const nodeId of plan.nodeIds) {
        delete document.nodes[nodeId];
        delete layout.positions[nodeId];
      }
      retire([...plan.nodeIds, ...plan.edgeIds, ...linkIds]);
      touchFlow(flowId);
      layoutChanged = true;
      break;
    }
    case "ADD_EDGE": {
      const { flowId, fromId, toId, condition, fromSide, toSide } = command.payload;
      if (
        !document.flows[flowId]
        || document.nodes[fromId]?.flowId !== flowId
        || document.nodes[toId]?.flowId !== flowId
      ) fail("INVALID_INPUT");
      if (Object.keys(document.edges).length >= LIMITS.edges) fail("LIMIT_EXCEEDED", { limit: LIMITS.edges });
      const edgeId = allocate();
      document.edges[edgeId] = {
        id: edgeId,
        flowId,
        version: 1,
        fromId,
        toId,
        condition,
        origin: "HUMAN",
        sourceRefs: [],
      };
      if (fromSide) { layout.edgeSides[edgeId] = { from: fromSide, to: toSide! }; layoutChanged = true; }
      touchFlow(flowId);
      break;
    }
    case "UPDATE_EDGE": {
      const edge = current(document.edges[command.payload.edgeId], command.payload.edgeId, command.expectedEntityVersion);
      if (edge.condition === command.payload.condition) return noChange();
      document.edges[edge.id] = { ...edge, condition: command.payload.condition, version: increment(edge.version) };
      versions[edge.id] = document.edges[edge.id]!.version;
      touchFlow(edge.flowId);
      break;
    }
    case "RECONNECT_EDGE": {
      const { edgeId, fromId, toId, fromSide, toSide } = command.payload;
      const edge = document.edges[edgeId] ?? fail("INVALID_INPUT");
      if (document.nodes[fromId]?.flowId !== edge.flowId || document.nodes[toId]?.flowId !== edge.flowId) {
        fail("INVALID_INPUT");
      }
      const endpointsChanged = edge.fromId !== fromId || edge.toId !== toId;
      const existingSides = layout.edgeSides[edgeId];
      // Sides-only saves do not advance documentRevision. Compare the inspected pair so a concurrent reconnect
      // cannot silently replace it; unrelated node positions and other edges remain independent.
      const expectedSides = command.payload.expectedSides;
      if (existingSides?.from !== expectedSides?.from || existingSides?.to !== expectedSides?.to) {
        fail("STALE_LAYOUT_REVISION", { edgeId });
      }
      const sidesChanged = fromSide ? existingSides?.from !== fromSide || existingSides?.to !== toSide : Boolean(existingSides);
      if (!endpointsChanged && !sidesChanged) return noChange();
      // The endpoints and their sides are one geometry decision: a plain reconnect (no sides given) clears them, a
      // side-carrying reconnect (endpoints changed or not) writes or replaces them. Either way the layout changed
      // exactly when the sides entry did, whether or not the endpoints (and so the document) also changed.
      if (fromSide) layout.edgeSides[edgeId] = { from: fromSide, to: toSide! };
      else delete layout.edgeSides[edgeId];
      layoutChanged = sidesChanged;
      if (!endpointsChanged) return layoutOnly(); // sides only: no document revision, no behaviour version
      document.edges[edgeId] = { ...edge, fromId, toId, version: increment(edge.version) };
      versions[edgeId] = document.edges[edgeId].version;
      touchFlow(edge.flowId);
      break;
    }
    case "DELETE_EDGE": {
      const edge = document.edges[command.payload.edgeId] ?? fail("INVALID_INPUT");
      delete document.edges[edge.id];
      if (layout.edgeSides[edge.id]) { delete layout.edgeSides[edge.id]; layoutChanged = true; }
      retire([edge.id]);
      touchFlow(edge.flowId);
      break;
    }
  }

  if (!inPlace) checkDraft({ document, layout });
  return { document, layout, documentChanged: true, layoutChanged, createdIds, versions, retiredIds };
}

/** Manual commands and batches retain their per-command counters. */
export function applyGraphCommand(saved: Draft, documentRevision: number, command: GraphCommand, newId: () => string, options: { inPlace?: boolean } = {}): Applied {
  return transformGraphCommand(saved, documentRevision, command, newId, options);
}

/** Reviewed atomic group: transform semantics first, then assign counters once from final effects, including evidence. */
export function applyGraphGroup(
  saved: Draft, documentRevision: number, commands: readonly GraphCommand[], newId: () => string,
  createdEvidence?: { sourceRefs: SourceRef[]; assumptionNotes: string[] },
): Applied {
  const working = structuredClone(saved);
  const createdIds: string[] = [], retiredIds: string[] = [];
  for (const command of commands) {
    const result = transformGraphCommand(working, documentRevision, command, newId, { inPlace: true, deferVersions: true });
    createdIds.push(...result.createdIds);
    retiredIds.push(...result.retiredIds);
    if (createdEvidence) for (const id of result.createdIds) {
      const node = working.document.nodes[id], edge = working.document.edges[id];
      if (node) { node.origin = "AI_SUGGESTED"; node.sourceRefs = structuredClone(createdEvidence.sourceRefs); node.assumptionNotes = [...createdEvidence.assumptionNotes]; }
      if (edge) { edge.origin = "AI_SUGGESTED"; edge.sourceRefs = structuredClone(createdEvidence.sourceRefs); }
    }
  }
  const versions: Record<string, number> = {};
  const affectedFlows = new Set<string>();
  for (const collection of ["nodes", "edges"] as const) {
    const before = saved.document[collection], after = working.document[collection];
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[id]) === JSON.stringify(after[id])) continue;
      affectedFlows.add((after[id] ?? before[id])!.flowId);
      const record = after[id], original = before[id];
      if (record && original) {
        record.version = bump(original.version);
        if ("behaviourVersion" in record && "behaviourVersion" in original) record.behaviourVersion = bump(original.behaviourVersion);
        versions[id] = record.version;
      }
    }
  }
  for (const [id, flow] of Object.entries(working.document.flows)) {
    const original = saved.document.flows[id];
    if (original && (affectedFlows.has(id) || JSON.stringify(flow) !== JSON.stringify(original))) {
      flow.version = bump(original.version);
      flow.behaviourVersion = bump(original.behaviourVersion);
      versions[id] = flow.version;
    }
  }
  checkDraft(working);
  return { ...working, documentChanged: JSON.stringify(saved.document) !== JSON.stringify(working.document), layoutChanged: JSON.stringify(saved.layout) !== JSON.stringify(working.layout), createdIds, versions, retiredIds };
}
