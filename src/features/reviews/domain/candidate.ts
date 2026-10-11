import { parseDraftPair, type ScopeDocument, type SourceRef } from "../../drafts/contracts/scope-document.ts";
import { graphWarnings } from "../../drafts/domain/warnings.ts";
import { confirmationCurrent, linkState } from "../../scope/domain/scope.ts";
import { citationMatches } from "../../sources/contracts/source-version.ts";
import type { CandidateCheck, CandidateError, CandidateErrorCode, CandidateInput } from "../contracts/review.ts";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T extends { id: string }>(records: Record<string, T>) => Object.values(records).sort((a, b) => compare(a.id, b.id));
const includedLink = (document: ScopeDocument, requirementId: string, nodeId: string) =>
  document.requirements[requirementId]?.inclusion === "INCLUDED" && document.flows[document.nodes[nodeId]?.flowId ?? ""]?.inclusion === "INCLUDED";
const sourceRefs = (refs: SourceRef[]) => refs.map(({ sourceVersionId, startLine, endLine, excerpt }) => ({ sourceVersionId, startLine, endLine, excerpt }))
  .sort((a, b) => compare(a.sourceVersionId, b.sourceVersionId) || a.startLine - b.startLine || a.endLine - b.endLine || compare(a.excerpt, b.excerpt));

/** Included meaning only. Preserve prose and ordered notes; counters, review stamps and layout do not prove a change. */
export function agreedProjection(document: ScopeDocument) {
  const nodes = sorted(document.nodes), edges = sorted(document.edges);
  return {
    projectGoal: document.projectGoal,
    flows: sorted(document.flows).filter(flow => flow.inclusion === "INCLUDED").map(({ id, title, purpose, classification }) => ({
      id, title, purpose, classification,
      nodes: nodes.filter(node => node.flowId === id).map(({ id, kind, label, description, actorLabel, sourceRefs: refs, assumptionNotes }) =>
        ({ id, kind, label, description, actorLabel, sourceRefs: sourceRefs(refs), assumptionNotes: [...assumptionNotes] })),
      edges: edges.filter(edge => edge.flowId === id).map(({ id, fromId, toId, condition, sourceRefs: refs }) =>
        ({ id, fromId, toId, condition, sourceRefs: sourceRefs(refs) })),
    })),
    requirements: sorted(document.requirements).filter(requirement => requirement.inclusion === "INCLUDED").map(({ id, title, statement, category, sourceRefs: refs, verificationMethod }) =>
      ({ id, title, statement, category, sourceRefs: sourceRefs(refs), verificationMethod: verificationMethod === null ? null : { description: verificationMethod.description, responsibleRole: verificationMethod.responsibleRole } })),
    traceLinks: Object.values(document.traceLinks).filter(link => includedLink(document, link.requirementId, link.nodeId))
      .sort((a, b) => compare(a.requirementId, b.requirementId) || compare(a.nodeId, b.nodeId))
      .map(({ requirementId, nodeId, explanation }) => ({ requirementId, nodeId, explanation })),
  };
}
/** Shared by browser preview and server freeze. Access, policy, lifecycle and exact saved guards remain server checks. */
export function checkCandidate({ draft, evidence, baseline }: CandidateInput): CandidateCheck {
  let document: ScopeDocument;
  try {
    document = parseDraftPair(draft.document, draft.layout).document;
  } catch {
    return { valid: false, errors: [{ code: "INVALID_DRAFT", targetId: null }], truncated: false };
  }
  const errors = new Map<string, CandidateError>();
  const add = (code: CandidateErrorCode, targetId: string | null) => errors.set(`${code}:${targetId ?? ""}`, { code, targetId });
  const flows = sorted(document.flows).filter(flow => flow.inclusion === "INCLUDED");
  const requirements = sorted(document.requirements).filter(requirement => requirement.inclusion === "INCLUDED");
  if (!flows.length && !requirements.length) add("NO_INCLUDED_CONTENT", null);
  for (const record of [...flows, ...requirements]) if (!confirmationCurrent(record)) add("CONFIRMATION_REQUIRED", record.id);
  for (const link of sorted(document.traceLinks)) {
    if (includedLink(document, link.requirementId, link.nodeId) && linkState(document, link) !== "CURRENT") add("LINK_REVIEW_REQUIRED", link.id);
  }
  const sources = new Map(evidence.map(source => [source.id, source.text]));
  for (const record of [...sorted(document.nodes), ...sorted(document.edges), ...sorted(document.requirements)]) {
    for (const ref of record.sourceRefs) {
      const text = sources.get(ref.sourceVersionId);
      if (text === undefined || !citationMatches(text, ref)) add("INVALID_CITATION", record.id);
    }
  }
  for (const flow of flows) {
    const nodes = sorted(document.nodes).filter(node => node.flowId === flow.id);
    const edges = sorted(document.edges).filter(edge => edge.flowId === flow.id);
    if (!nodes.length) { add("EMPTY_FLOW", flow.id); continue; }
    for (const warning of graphWarnings(document, flow.id)) add(warning.code, warning.targetId);
    const incoming = new Map(nodes.map(node => [node.id, [] as typeof edges]));
    const outgoing = new Map(nodes.map(node => [node.id, [] as typeof edges]));
    for (const edge of edges) {
      incoming.get(edge.toId)!.push(edge);
      outgoing.get(edge.fromId)!.push(edge);
    }
    // Both walks use visited sets: cycles with an exit work; closed cycles cannot reach an outcome.
    const reachable = (kind: "START" | "OUTCOME", reverse: boolean) => {
      const visited = new Set(nodes.filter(node => node.kind === kind).map(node => node.id));
      for (const nodeId of visited) {
        for (const edge of (reverse ? incoming : outgoing).get(nodeId)!) visited.add(reverse ? edge.fromId : edge.toId);
      }
      return visited;
    };
    const fromStart = reachable("START", false), toOutcome = reachable("OUTCOME", true);
    for (const node of nodes) {
      const exits = outgoing.get(node.id)!;
      if (node.kind === "START" && incoming.get(node.id)!.length) add("START_HAS_INCOMING", node.id);
      if (node.kind === "OUTCOME" && exits.length) add("OUTCOME_HAS_OUTGOING", node.id);
      if ((node.kind === "ACTION" || node.kind === "DATA_STORE") && exits.length !== 1) add("ACTION_OUTGOING_COUNT", node.id);
      if (node.kind === "DECISION") {
        if (exits.length < 2) add("DECISION_OUTGOING_COUNT", node.id);
        const labels = exits.map(edge => edge.condition.trim()).filter(Boolean);
        if (new Set(labels).size !== labels.length) add("DUPLICATE_BRANCH_LABEL", node.id);
      }
      if (!fromStart.has(node.id)) add("UNREACHABLE_FROM_START", node.id);
      if (!toOutcome.has(node.id)) add("CANNOT_REACH_OUTCOME", node.id);
    }
  }
  if (baseline !== null && JSON.stringify(agreedProjection(document)) === JSON.stringify(agreedProjection(baseline))) add("NO_SEMANTIC_CHANGE", null);
  const ordered = [...errors.values()].sort((a, b) => compare(a.code, b.code) || compare(a.targetId ?? "", b.targetId ?? ""));
  return { valid: ordered.length === 0, errors: ordered.slice(0, 50), truncated: ordered.length > 50 };
}
