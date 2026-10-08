import type { RequirementRecord, ScopeDocument, SourceRef, TraceLinkRecord, VerificationMethod } from "../../drafts/contracts/scope-document.ts";
import { LIMITS } from "../../drafts/contracts/scope-document.ts";
import { bump, checkDraft, current, GraphError, usedIds, type Applied, type Draft } from "../../drafts/domain/graph.ts";
import type { RequirementFields, ScopeCommand } from "../contracts/scope-commands.ts";

// Pure scope transforms (Data02 version matrix). Shared by the server dispatcher and the Specs panel previews.
/** `displayId` comes from the project's monotonic requirement counter (Task 3); labels are never reused. */
export type ScopeContext = { actorId: string; now: string; displayId?: string };
export type LinkState = "PROPOSED" | "CURRENT" | "NEEDS_REVIEW";

const MATERIAL = ["title", "statement", "category", "inclusion", "sourceRefs", "verification"] as const;

export const formatDisplayId = (sequence: number) => `REQ-${String(sequence).padStart(3, "0")}`;

export const confirmationCurrent = (requirement: RequirementRecord) => requirement.confirmation?.behaviourVersion === requirement.behaviourVersion;

export function linkState(document: ScopeDocument, link: TraceLinkRecord): LinkState {
  if (link.reviewedBy === null) return "PROPOSED";
  const requirement = document.requirements[link.requirementId], node = document.nodes[link.nodeId];
  return requirement?.behaviourVersion === link.reviewedRequirementBehaviourVersion && node?.behaviourVersion === link.reviewedNodeBehaviourVersion ? "CURRENT" : "NEEDS_REVIEW";
}

export function requirementPlan(document: ScopeDocument, requirementId: string): { traceLinkIds: string[] } {
  return { traceLinkIds: Object.values(document.traceLinks).filter((link) => link.requirementId === requirementId).map((link) => link.id).sort() };
}

/** Every step and connection chosen AI operations remove, for disclosure of affected trace links. */
export function removedRecordIds(operations: ReadonlyArray<{ id: string; edit: { command: string; payload: unknown } }>, operationIds: readonly string[]): string[] {
  const chosen = new Set(operationIds), removed = new Set<string>();
  for (const { id, edit } of operations) {
    if (!chosen.has(id)) continue;
    if (edit.command === "DELETE_NODES") {
      const { nodeIds, removeEdgeIds } = edit.payload as { nodeIds: string[]; removeEdgeIds: string[] };
      nodeIds.forEach((nodeId) => removed.add(nodeId));
      removeEdgeIds.forEach((edgeId) => removed.add(edgeId));
    }
    if (edit.command === "DELETE_EDGE") removed.add((edit.payload as { edgeId: string }).edgeId);
  }
  return [...removed].sort();
}

/** Current work assigned to a former member returns to unassigned (record version only; history keeps its authors). */
export function unassignMember(document: ScopeDocument, profileId: string): { document: ScopeDocument; changedIds: string[] } {
  const memberId = profileId.toLowerCase();
  const next = structuredClone(document);
  const changedIds: string[] = [];
  for (const requirement of Object.values(next.requirements)) {
    if (requirement.ownerId !== memberId) continue;
    next.requirements[requirement.id] = { ...requirement, ownerId: null, version: bump(requirement.version) };
    changedIds.push(requirement.id);
  }
  return { document: next, changedIds: changedIds.sort() };
}

/** Citations a command adds or keeps: the server checks each one against immutable same-project source text. */
export function commandSourceRefs(command: ScopeCommand): SourceRef[] {
  return command.command === "CREATE_REQUIREMENT" || command.command === "UPDATE_REQUIREMENT" ? command.payload.sourceRefs ?? [] : [];
}

/** Profiles a command assigns: the server checks they are current project members. */
export function commandMembers(command: ScopeCommand): string[] {
  return (command.command === "CREATE_REQUIREMENT" || command.command === "UPDATE_REQUIREMENT") && command.payload.ownerId ? [command.payload.ownerId] : [];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameVerification = (current: VerificationMethod, value: RequirementFields["verification"]) =>
  current === null ? value === null : value !== null && current.description === value.description && current.responsibleRole === value.responsibleRole;
const verificationOf = (value: RequirementFields["verification"], current: VerificationMethod = null): VerificationMethod =>
  sameVerification(current, value) ? current : value === null ? null : { ...value, reviewedBehaviourVersion: null, reviewedBy: null, reviewedAt: null };

export function applyScopeCommand(saved: Draft, documentRevision: number, command: ScopeCommand, newId: () => string, context: ScopeContext): Applied {
  if ("expectedDocumentRevision" in command && command.expectedDocumentRevision !== documentRevision) {
    throw new GraphError("STALE_DOCUMENT_REVISION", { documentRevision });
  }
  const document = structuredClone(saved.document);
  const used = usedIds(document);
  const createdIds: string[] = [], retiredIds: string[] = [];
  const versions: Record<string, number> = {};
  const unchanged = (): Applied => ({ ...saved, documentChanged: false, layoutChanged: false, createdIds: [], versions: {}, retiredIds: [] });
  const allocate = () => {
    const value = newId();
    if (used.has(value)) throw new GraphError("INVALID_INPUT");
    used.add(value);
    createdIds.push(value);
    return value;
  };
  const retire = (removed: string[]) => {
    retiredIds.push(...removed);
    document.retiredEntityIds = [...document.retiredEntityIds, ...removed].sort();
  };

  switch (command.command) {
    case "CREATE_REQUIREMENT": {
      if (Object.keys(document.requirements).length >= LIMITS.requirements) throw new GraphError("LIMIT_EXCEEDED", { limit: LIMITS.requirements });
      const { verification, ...fields } = command.payload;
      const requirementId = allocate();
      const displayId = context.displayId;
      if (!displayId) throw new Error("DISPLAY_ID_REQUIRED");
      document.requirements[requirementId] = {
        id: requirementId, displayId, version: 1, behaviourVersion: 1, ...fields, origin: "HUMAN",
        decisionIds: [], confirmation: null, verificationMethod: verificationOf(verification),
      };
      break;
    }
    case "UPDATE_REQUIREMENT": {
      const { requirementId, verification, ...fields } = command.payload;
      const requirement = current(document.requirements[requirementId], requirementId, command.expectedEntityVersion);
      const next: RequirementRecord = { ...requirement, ...fields, ...(verification === undefined ? {} : { verificationMethod: verificationOf(verification, requirement.verificationMethod) }) };
      if (same(next, requirement)) return unchanged();
      const material = MATERIAL.some((key) => key === "verification"
        ? verification !== undefined && !same(next.verificationMethod, requirement.verificationMethod)
        : !same(next[key], requirement[key]));
      document.requirements[requirementId] = { ...next, version: bump(requirement.version), behaviourVersion: material ? bump(requirement.behaviourVersion) : requirement.behaviourVersion };
      versions[requirementId] = document.requirements[requirementId].version;
      break;
    }
    case "DELETE_REQUIREMENT": {
      const { requirementId, removeLinkIds } = command.payload;
      if (!document.requirements[requirementId]) throw new GraphError("INVALID_INPUT");
      const plan = requirementPlan(document, requirementId);
      if (!same(plan.traceLinkIds, [...removeLinkIds].sort())) throw new GraphError("DEPENDENCY_CONFLICT");
      for (const linkId of plan.traceLinkIds) delete document.traceLinks[linkId];
      delete document.requirements[requirementId];
      retire([requirementId, ...plan.traceLinkIds]);
      break;
    }
    case "CONFIRM_REQUIREMENT": {
      const requirement = current(document.requirements[command.payload.requirementId], command.payload.requirementId, command.expectedEntityVersion);
      if (confirmationCurrent(requirement)) return unchanged();
      document.requirements[requirement.id] = { ...requirement, version: bump(requirement.version), confirmation: { behaviourVersion: requirement.behaviourVersion, actorId: context.actorId, confirmedAt: context.now } };
      versions[requirement.id] = document.requirements[requirement.id]!.version;
      break;
    }
    case "ADD_TRACE_LINK": {
      const { requirementId, nodeId, explanation } = command.payload;
      if (!document.requirements[requirementId] || !document.nodes[nodeId]) throw new GraphError("INVALID_INPUT");
      if (Object.values(document.traceLinks).some((link) => link.requirementId === requirementId && link.nodeId === nodeId)) throw new GraphError("INVALID_INPUT");
      if (Object.keys(document.traceLinks).length >= LIMITS.traceLinks) throw new GraphError("LIMIT_EXCEEDED", { limit: LIMITS.traceLinks });
      const linkId = allocate();
      document.traceLinks[linkId] = { id: linkId, version: 1, requirementId, nodeId, explanation, reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
      break;
    }
    case "UPDATE_TRACE_LINK": {
      const link = current(document.traceLinks[command.payload.linkId], command.payload.linkId, command.expectedEntityVersion);
      if (link.explanation === command.payload.explanation) return unchanged();
      document.traceLinks[link.id] = { ...link, explanation: command.payload.explanation, version: bump(link.version), reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
      versions[link.id] = document.traceLinks[link.id]!.version;
      break;
    }
    case "CONFIRM_TRACE_LINK": {
      const link = current(document.traceLinks[command.payload.linkId], command.payload.linkId, command.expectedEntityVersion);
      const requirement = document.requirements[link.requirementId], node = document.nodes[link.nodeId];
      if (!requirement || !node) throw new GraphError("INVALID_INPUT");
      if (requirement.behaviourVersion !== command.payload.expectedRequirementBehaviourVersion) throw new GraphError("STALE_ENTITY_VERSION", { entityId: requirement.id, currentVersion: requirement.version });
      if (node.behaviourVersion !== command.payload.expectedNodeBehaviourVersion) throw new GraphError("STALE_ENTITY_VERSION", { entityId: node.id, currentVersion: node.version });
      if (linkState(document, link) === "CURRENT") return unchanged();
      document.traceLinks[link.id] = {
        ...link, version: bump(link.version), reviewedRequirementBehaviourVersion: requirement.behaviourVersion,
        reviewedNodeBehaviourVersion: node.behaviourVersion, reviewedBy: context.actorId, reviewedAt: context.now,
      };
      versions[link.id] = document.traceLinks[link.id]!.version;
      break;
    }
    case "DELETE_TRACE_LINK": {
      if (!document.traceLinks[command.payload.linkId]) throw new GraphError("INVALID_INPUT");
      delete document.traceLinks[command.payload.linkId];
      retire([command.payload.linkId]);
      break;
    }
  }
  checkDraft({ document, layout: saved.layout });
  return { document, layout: saved.layout, documentChanged: true, layoutChanged: false, createdIds, versions, retiredIds };
}
