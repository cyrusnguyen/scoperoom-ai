import { emptyDraft, type RequirementRecord, type ScopeDocument } from "../../src/features/drafts/contracts/scope-document.ts";

export const ids = {
  flow: "10000000-0000-4000-8000-000000000001", node: "10000000-0000-4000-8000-000000000002", req: "10000000-0000-4000-8000-000000000003",
  link: "10000000-0000-4000-8000-000000000004", actor: "10000000-0000-4000-8000-000000000005", other: "10000000-0000-4000-8000-000000000006",
};
export const NOW = "2026-10-07T10:00:00.000Z";

export function requirement(over: Partial<RequirementRecord> = {}): RequirementRecord {
  return { id: ids.req, displayId: "REQ-001", version: 1, behaviourVersion: 1, title: "Pay by card", statement: "", category: "FUNCTIONAL", inclusion: "UNDECIDED", origin: "HUMAN", sourceRefs: [], decisionIds: [], ownerId: null, confirmation: null, verificationMethod: null, ...over };
}

export function graphDocument(): ScopeDocument {
  const { document } = emptyDraft();
  document.flows[ids.flow] = { id: ids.flow, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: null, verificationMethod: null };
  document.nodes[ids.node] = { id: ids.node, flowId: ids.flow, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Pay", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
  return document;
}
