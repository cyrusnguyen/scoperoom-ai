import type { GraphCommand } from "../../drafts/contracts/commands.ts";
import { emptyDraft } from "../../drafts/contracts/scope-document.ts";
import { applyGraphGroup, byId, type Applied, type Draft } from "../../drafts/domain/graph.ts";
import { LOCAL_REF, type CapturedInput, type ProposalDiff, type ValidatedProposal } from "../contracts/tasks.ts";
import { selectOperations } from "./select-operations.ts";
import { ResultError, validateResult } from "./validate-result.ts";

export type AppliedProposal = Applied & { idMap: Record<string, string>; createdIdMap: Record<string, string>; changedIds: string[]; actualCommands: GraphCommand[] };

/** Adapt SQL-owned edits to manual domain semantics against the latest saved layout. The caller supplies fresh final UUIDs. */
export function applyProposal(
  saved: Draft, capture: CapturedInput, proposal: ValidatedProposal, selectedIds: readonly string[], newId: () => string,
): AppliedProposal {
  const result = validateResult(capture, proposal);
  if (result.kind !== "proposal") throw new ResultError("NO_PROPOSAL");
  const operations = selectOperations(result.operations, selectedIds);
  const idMap: Record<string, string> = {};
  const createdIdMap: Record<string, string> = {};
  const allocated: string[] = [];
  for (const operation of operations) {
    const edit = operation.edit;
    if (edit.command === "CREATE_FLOW" || edit.command === "ADD_NODE" || edit.command === "ADD_EDGE") {
      const id = newId();
      createdIdMap[operation.id] = id;
      if (edit.command !== "ADD_EDGE") idMap[edit.payload.ref] = id;
      allocated.push(id);
    }
  }
  const resolve = (id: string) => LOCAL_REF.test(id) ? idMap[id] ?? (() => { throw new ResultError("REFERENCE"); })() : id;
  const revision = capture.documentRevision;
  const commands: GraphCommand[] = operations.map(operation => {
    const edit = operation.edit;
    const base = { commandSchemaVersion: 1 as const };
    switch (edit.command) {
      case "CREATE_FLOW": {
        const { ref, ...fields } = edit.payload;
        void ref;
        return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: { ...fields, inclusion: "UNDECIDED" } };
      }
      case "ADD_NODE": {
        const { ref, ...fields } = edit.payload;
        void ref;
        return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: { ...fields, flowId: resolve(fields.flowId) } };
      }
      case "UPDATE_NODE": return { ...base, command: edit.command, expectedEntityVersion: saved.document.nodes[edit.payload.nodeId]?.version ?? -1, payload: edit.payload };
      case "UPDATE_EDGE": return { ...base, command: edit.command, expectedEntityVersion: saved.document.edges[edit.payload.edgeId]?.version ?? -1, payload: edit.payload };
      case "DELETE_NODES": return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: { flowId: resolve(edit.payload.flowId), nodeIds: edit.payload.nodeIds.map(resolve), removeEdgeIds: edit.payload.removeEdgeIds.map(resolve) } };
      case "ADD_EDGE": return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: { ...edit.payload, flowId: resolve(edit.payload.flowId), fromId: resolve(edit.payload.fromId), toId: resolve(edit.payload.toId) } };
      case "RECONNECT_EDGE": {
        const sides = saved.layout.edgeSides[edit.payload.edgeId];
        return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: { ...edit.payload, fromId: resolve(edit.payload.fromId), toId: resolve(edit.payload.toId), expectedSides: sides ?? null, ...(sides ? { fromSide: sides.from, toSide: sides.to } : {}) } };
      }
      case "DELETE_EDGE": return { ...base, command: edit.command, expectedDocumentRevision: revision, payload: edit.payload };
    }
  });
  let index = 0;
  const applied = applyGraphGroup(saved, revision, commands, () => allocated[index++]!, { sourceRefs: result.citations, assumptionNotes: result.assumptions });
  return { ...applied, idMap, createdIdMap, actualCommands: structuredClone(commands), changedIds: [...applied.createdIds, ...Object.keys(applied.versions), ...applied.retiredIds].sort() };
}

/** Reconstruct only captured fields with synthetic geometry for running the shared domain's invariant checks. */
function capturedDraft(capture: CapturedInput): Draft {
  const draft = emptyDraft();
  for (const flow of capture.graph.flows) {
    draft.document.flows[flow.id] = { ...flow, confirmation: null, verificationMethod: null };
    draft.layout.directions[flow.id] = "TB";
  }
  for (const node of capture.graph.nodes) {
    const { readOnly, ...fields } = node;
    void readOnly;
    draft.document.nodes[node.id] = { ...fields, origin: "HUMAN", sourceRefs: [] };
    draft.layout.positions[node.id] = { x: 0, y: 0, version: 1 };
  }
  for (const edge of capture.graph.edges) draft.document.edges[edge.id] = { ...edge, origin: "HUMAN", sourceRefs: [] };
  return draft;
}

export function proposalDiff(capture: CapturedInput, proposal: ValidatedProposal, selectedIds: readonly string[]): ProposalDiff {
  const before = capturedDraft(capture);
  const used = new Set([...Object.keys(before.document.flows), ...Object.keys(before.document.nodes), ...Object.keys(before.document.edges)]);
  let index = 0;
  const temporaryId = () => {
    let id: string;
    do { id = `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`; } while (used.has(id));
    used.add(id);
    return id;
  };
  const applied = applyProposal(before, capture, proposal, selectedIds, temporaryId);
  const result = validateResult(capture, proposal);
  if (result.kind !== "proposal") throw new ResultError("NO_PROPOSAL");
  const boundary = new Set(capture.graph.boundaryNodeIds);
  return {
    selectedOperationIds: selectOperations(result.operations, selectedIds).map(operation => operation.id),
    before: structuredClone(capture.graph),
    after: {
      flows: Object.values(applied.document.flows).sort(byId).map(({ confirmation, verificationMethod, ...flow }) => { void confirmation; void verificationMethod; return flow; }),
      nodes: Object.values(applied.document.nodes).sort(byId).map(({ origin, sourceRefs, ...node }) => { void origin; void sourceRefs; return { ...node, readOnly: boundary.has(node.id) }; }),
      edges: Object.values(applied.document.edges).sort(byId).map(({ origin, sourceRefs, ...edge }) => { void origin; void sourceRefs; return edge; }),
      boundaryNodeIds: [...capture.graph.boundaryNodeIds],
    },
    createdIds: applied.createdIds,
    updatedIds: Object.keys(applied.versions).sort(),
    retiredIds: applied.retiredIds,
  };
}
