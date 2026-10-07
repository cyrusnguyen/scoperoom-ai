import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLayout } from "../src/features/drafts/contracts/draft-layout.ts";
import { parseDocument, parseTime } from "../src/features/drafts/contracts/scope-document.ts";
import { MAX_VERSION } from "../src/features/drafts/contracts/strict.ts";
import { applyChanges } from "../src/features/drafts/domain/changes.ts";
import { applyGraphCommand, applyGraphGroup, GraphError, incidentTraceLinks } from "../src/features/drafts/domain/graph.ts";
import { parseScopeCommand } from "../src/features/scope/contracts/scope-commands.ts";
import { applyScopeCommand, formatDisplayId, linkState, removedRecordIds, requirementPlan, unassignMember } from "../src/features/scope/domain/scope.ts";
import { graphDocument, ids, NOW, requirement } from "./support/scope-fixtures.ts";

const context = { actorId: ids.actor, now: NOW, displayId: "REQ-001" };
const fields = { title: "Pay by card", statement: "Card payments", category: "FUNCTIONAL" as const, inclusion: "INCLUDED" as const, sourceRefs: [], ownerId: null, verification: null };
const command = (raw: Record<string, unknown>) => parseScopeCommand({ commandSchemaVersion: 1, ...raw });
let counter = 0;
const newId = () => `20000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function draft() {
  const document = graphDocument();
  return {
    document,
    layout: parseLayout({ schemaVersion: 1, positions: { [ids.node]: { x: 0, y: 0, version: 1 } }, directions: { [ids.flow]: "TB" }, edgeSides: {} }, new Set([ids.node]), new Set([ids.flow]), new Set()),
  };
}

test("a removed member's requirements become unassigned without a behaviour change", () => {
  const document = graphDocument();
  const confirmation = { behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW };
  const verificationMethod = { description: "Check card payment", responsibleRole: "QA", reviewedBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  document.requirements[ids.req] = requirement({ ownerId: ids.actor, confirmation, verificationMethod });
  document.requirements[ids.other] = requirement({ id: ids.other, displayId: "REQ-002", ownerId: null });
  document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "Payment step", reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  const before = structuredClone(document);
  const { document: next, changedIds } = unassignMember(document, ids.actor);
  assert.deepEqual(changedIds, [ids.req]);
  assert.deepEqual(next.requirements[ids.req], { ...before.requirements[ids.req], ownerId: null, version: 2 });
  assert.deepEqual(next.requirements[ids.other], before.requirements[ids.other]);
  assert.deepEqual(next.traceLinks, before.traceLinks, "link reviews keep their historical author and versions");
  assert.equal(linkState(next, next.traceLinks[ids.link]!), "CURRENT");
  assert.equal(unassignMember(document, ids.other).changedIds.length, 0);
  assert.deepEqual(document, before, "the input is not changed");
});

test("unassignment matches a member UUID regardless of route parameter casing", () => {
  const document = graphDocument();
  const memberId = "abcdef00-abcd-4abc-8abc-abcdefabcdef";
  document.requirements[ids.req] = requirement({ ownerId: memberId });
  const { document: next, changedIds } = unassignMember(document, memberId.toUpperCase());
  assert.deepEqual(changedIds, [ids.req]);
  assert.equal(next.requirements[ids.req]!.ownerId, null);
  assert.equal(document.requirements[ids.req]!.ownerId, memberId);
});

test("unassignment refuses version exhaustion without changing the input", () => {
  const document = graphDocument();
  document.requirements[ids.req] = requirement({ ownerId: ids.actor, version: MAX_VERSION });
  assert.throws(() => unassignMember(document, ids.actor), /VERSION_EXHAUSTED/);
  assert.deepEqual(document.requirements[ids.req], requirement({ ownerId: ids.actor, version: MAX_VERSION }));
});

test("timestamps reject impossible UTC calendar dates", () => {
  assert.throws(() => parseTime("2026-02-30T10:00:00.000Z"), /INVALID_INPUT/);
});

test("requirements and trace links parse with their reference rules", () => {
  const document = graphDocument();
  document.requirements[ids.req] = requirement({ confirmation: { behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW }, verificationMethod: { description: "Check a card payment", responsibleRole: "QA", reviewedBehaviourVersion: null, reviewedBy: null, reviewedAt: null } });
  document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "", reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
  assert.deepEqual(parseDocument(structuredClone(document)), document);

  const dangling = structuredClone(document);
  dangling.traceLinks[ids.link]!.nodeId = ids.other;
  assert.throws(() => parseDocument(dangling), "link to a missing step");

  const halfReviewed = structuredClone(document);
  halfReviewed.traceLinks[ids.link]!.reviewedBy = ids.actor;
  assert.throws(() => parseDocument(halfReviewed), "review stamp is all or nothing");

  const duplicate = structuredClone(document);
  duplicate.traceLinks[ids.other] = { ...document.traceLinks[ids.link]!, id: ids.other };
  assert.throws(() => parseDocument(duplicate), "one link per requirement and step");

  const clash = structuredClone(document);
  clash.requirements[ids.node] = requirement({ id: ids.node, displayId: "REQ-002" });
  assert.throws(() => parseDocument(clash), "ids are unique across collections");

  const sameLabel = structuredClone(document);
  sameLabel.requirements[ids.other] = requirement({ id: ids.other });
  assert.throws(() => parseDocument(sameLabel), "display ids are unique");

  const decided = structuredClone(document);
  decided.requirements[ids.req]!.decisionIds = [ids.other];
  assert.throws(() => parseDocument(decided), "decision links need decisions");
});

test("requirement meaning bumps behaviour, owner does not, confirmation is exact", () => {
  const created = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, context);
  const id = created.createdIds[0]!;
  assert.equal(created.document.requirements[id]!.displayId, "REQ-001");
  const confirmed = applyScopeCommand(created, 2, command({ command: "CONFIRM_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: id } }), newId, context);
  assert.deepEqual(confirmed.document.requirements[id]!.confirmation, { behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW });
  assert.equal(confirmed.document.requirements[id]!.behaviourVersion, 1, "confirming never changes behaviour");
  assert.equal(applyScopeCommand(confirmed, 3, command({ command: "CONFIRM_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId: id } }), newId, context).documentChanged, false);
  const owned = applyScopeCommand(confirmed, 3, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId: id, ownerId: ids.actor } }), newId, context);
  assert.deepEqual([owned.document.requirements[id]!.version, owned.document.requirements[id]!.behaviourVersion], [3, 1]);
  const changed = applyScopeCommand(owned, 4, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 3, payload: { requirementId: id, statement: "Cards and wallets" } }), newId, context);
  assert.equal(changed.document.requirements[id]!.behaviourVersion, 2);
  assert.notEqual(changed.document.requirements[id]!.confirmation?.behaviourVersion, 2, "old confirmation is no longer current");
  assert.throws(() => applyScopeCommand(changed, 5, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 3, payload: { requirementId: id, title: "x" } }), newId, context), /STALE_ENTITY_VERSION/);
});

test("link review freshness follows endpoint behaviour only", () => {
  let state = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, context);
  const requirementId = state.createdIds[0]!;
  state = applyScopeCommand(state, 2, command({ command: "ADD_TRACE_LINK", expectedDocumentRevision: 2, payload: { requirementId, nodeId: ids.node, explanation: "" } }), newId, context);
  const linkId = state.createdIds[0]!;
  assert.equal(linkState(state.document, state.document.traceLinks[linkId]!), "PROPOSED");
  const confirm = (version: number, requirementVersion: number, nodeVersion: number) => command({ command: "CONFIRM_TRACE_LINK", expectedEntityVersion: version, payload: { linkId, expectedRequirementBehaviourVersion: requirementVersion, expectedNodeBehaviourVersion: nodeVersion } });
  state = applyScopeCommand(state, 3, confirm(1, 1, 1), newId, context);
  assert.equal(linkState(state.document, state.document.traceLinks[linkId]!), "CURRENT");
  assert.equal(state.document.nodes[ids.node]!.behaviourVersion, 1, "confirming a link never bumps an endpoint");
  assert.equal(state.document.requirements[requirementId]!.behaviourVersion, 1);
  const edited = applyGraphCommand(state, 4, { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: ids.node, label: "Pay now" } }, newId);
  assert.equal(linkState(edited.document, edited.document.traceLinks[linkId]!), "NEEDS_REVIEW");
  assert.throws(() => applyScopeCommand(edited, 5, confirm(2, 1, 1), newId, context), /STALE_ENTITY_VERSION/);
  const reviewed = applyScopeCommand(edited, 5, confirm(2, 1, 2), newId, context);
  assert.equal(linkState(reviewed.document, reviewed.document.traceLinks[linkId]!), "CURRENT");
});

test("deleting a step or requirement removes its links in the same change", () => {
  let state = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, context);
  const requirementId = state.createdIds[0]!;
  state = applyScopeCommand(state, 2, command({ command: "ADD_TRACE_LINK", expectedDocumentRevision: 2, payload: { requirementId, nodeId: ids.node, explanation: "" } }), newId, context);
  const linkId = state.createdIds[0]!;
  assert.deepEqual(requirementPlan(state.document, requirementId), { traceLinkIds: [linkId] });
  assert.throws(() => applyScopeCommand(state, 3, command({ command: "DELETE_REQUIREMENT", expectedDocumentRevision: 3, payload: { requirementId, removeLinkIds: [] } }), newId, context), /DEPENDENCY_CONFLICT/);
  const gone = applyGraphCommand(state, 3, { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 3, payload: { flowId: ids.flow, nodeIds: [ids.node], removeEdgeIds: [] } }, newId);
  assert.deepEqual(gone.document.traceLinks, {});
  assert.ok(gone.retiredIds.includes(linkId));

  const wholeFlow = applyGraphCommand(state, 3, { commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: 3, payload: { flowId: ids.flow, removeNodeIds: [ids.node], removeEdgeIds: [] } }, newId);
  assert.deepEqual(wholeFlow.document.traceLinks, {});
  assert.ok(wholeFlow.retiredIds.includes(linkId));
});

test("a batch cannot reuse a requirement id", () => {
  const state = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, context);
  const reused = state.createdIds[0]!;
  assert.throws(() => applyChanges(state, 2, { commands: [{ command: { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 2, payload: { title: "F", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, proposedIds: [reused] }], moves: [] }), /INVALID_INPUT/);
});

test("AI graph groups reject scope ids and retire linked steps atomically", () => {
  let state = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, context);
  const requirementId = state.createdIds[0]!;
  state = applyScopeCommand(state, 2, command({ command: "ADD_TRACE_LINK", expectedDocumentRevision: 2, payload: { requirementId, nodeId: ids.node, explanation: "" } }), newId, context);
  const linkId = state.createdIds[0]!;
  const group = [{ commandSchemaVersion: 1 as const, command: "DELETE_NODES" as const, expectedDocumentRevision: 3, payload: { flowId: ids.flow, nodeIds: [ids.node], removeEdgeIds: [] } }];
  const deleted = applyGraphGroup(state, 3, group, newId);
  assert.deepEqual(deleted.document.traceLinks, {});
  assert.ok(deleted.retiredIds.includes(linkId));
  assert.throws(
    () => applyGraphGroup(state, 3, [{ commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 3, payload: { title: "F", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }], () => requirementId),
    (error: unknown) => error instanceof GraphError && error.code === "INVALID_INPUT",
  );
});

test("a new requirement takes the server-allocated label", () => {
  assert.deepEqual([formatDisplayId(1), formatDisplayId(42), formatDisplayId(1000)], ["REQ-001", "REQ-042", "REQ-1000"]);
  const created = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, { ...context, displayId: "REQ-007" });
  assert.equal(created.document.requirements[created.createdIds[0]!]!.displayId, "REQ-007");
  assert.throws(() => applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), newId, { actorId: ids.actor, now: NOW }), /DISPLAY_ID_REQUIRED/);
});

test("an unchanged reviewed verification remains a no-op", () => {
  const state = applyScopeCommand(draft(), 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: { ...fields, verification: { description: "Check payment", responsibleRole: "QA" } } }), newId, context);
  const requirementId = state.createdIds[0]!;
  state.document.requirements[requirementId]!.verificationMethod = { description: "Check payment", responsibleRole: "QA", reviewedBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  const applied = applyScopeCommand(state, 2, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId, verification: { description: "Check payment", responsibleRole: "QA" } } }), newId, context);
  assert.equal(applied.documentChanged, false);
  assert.deepEqual(applied.document.requirements[requirementId]!.verificationMethod, state.document.requirements[requirementId]!.verificationMethod);
});

test("scope command parsing rejects forged metadata, wrong guards and empty updates", () => {
  const valid = { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: ids.req, ownerId: null } };
  assert.deepEqual(parseScopeCommand(valid), valid);
  for (const raw of [
    { ...valid, payload: { requirementId: ids.req } },
    { ...valid, expectedDocumentRevision: 1 },
    { ...valid, expectedEntityVersion: 0 },
    { ...valid, payload: { ...valid.payload, confirmation: { behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW } } },
    { ...valid, payload: { requirementId: ids.req, verification: { description: "Check", responsibleRole: "QA", reviewedBy: ids.actor } } },
    { commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: { ...fields, displayId: "REQ-900" } },
    { commandSchemaVersion: 1, command: "CONFIRM_TRACE_LINK", expectedEntityVersion: 1, payload: { linkId: ids.link, expectedRequirementBehaviourVersion: 1 } },
  ]) assert.throws(() => parseScopeCommand(raw), /INVALID_INPUT/);
});

test("meaningful verification edits clear review, advance behaviour once and stale confirmation", () => {
  const state = draft();
  state.document.requirements[ids.req] = requirement({
    confirmation: { behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW },
    verificationMethod: { description: "Check payment", responsibleRole: "QA", reviewedBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW },
  });
  const before = structuredClone(state);
  const edited = applyScopeCommand(state, 1, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: ids.req, ownerId: ids.actor, verification: { description: "Check declined payment", responsibleRole: "QA" } } }), newId, context);
  const value = edited.document.requirements[ids.req]!;
  assert.deepEqual([value.version, value.behaviourVersion], [2, 2]);
  assert.deepEqual(value.verificationMethod, { description: "Check declined payment", responsibleRole: "QA", reviewedBehaviourVersion: null, reviewedBy: null, reviewedAt: null });
  assert.equal(value.confirmation?.behaviourVersion, 1);
  assert.equal(edited.layoutChanged, false);
  assert.deepEqual(state, before);
  const removed = applyScopeCommand(edited, 2, command({ command: "UPDATE_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId: ids.req, verification: null } }), newId, context);
  assert.equal(removed.document.requirements[ids.req]!.verificationMethod, null);
  assert.deepEqual([removed.document.requirements[ids.req]!.version, removed.document.requirements[ids.req]!.behaviourVersion], [3, 3]);
});

test("link explanation edits clear review without changing endpoint behaviour and no-ops keep guards", () => {
  const state = draft();
  state.document.requirements[ids.req] = requirement();
  state.document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "Supports payment", reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  const before = structuredClone(state);
  const edit = (expectedEntityVersion: number, explanation: string) => command({ command: "UPDATE_TRACE_LINK", expectedEntityVersion, payload: { linkId: ids.link, explanation } });
  const noop = applyScopeCommand(state, 1, edit(1, "Supports payment"), newId, context);
  assert.equal(noop.documentChanged, false);
  assert.deepEqual(noop.versions, {});
  assert.throws(() => applyScopeCommand(state, 1, edit(2, "Supports payment"), newId, context), /STALE_ENTITY_VERSION/);
  const changed = applyScopeCommand(state, 1, edit(1, "Supports declined payment"), newId, context);
  assert.equal(changed.document.traceLinks[ids.link]!.version, 2);
  assert.equal(linkState(changed.document, changed.document.traceLinks[ids.link]!), "PROPOSED");
  assert.deepEqual([changed.document.traceLinks[ids.link]!.reviewedRequirementBehaviourVersion, changed.document.traceLinks[ids.link]!.reviewedNodeBehaviourVersion, changed.document.traceLinks[ids.link]!.reviewedBy, changed.document.traceLinks[ids.link]!.reviewedAt], [null, null, null, null]);
  assert.deepEqual(changed.document.requirements, state.document.requirements);
  assert.deepEqual(changed.document.nodes, state.document.nodes);
  assert.deepEqual(state, before);
});

test("requirement and link deletion retire exactly removed ids and refusals preserve input", () => {
  const state = draft();
  state.document.requirements[ids.req] = requirement();
  state.document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "", reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
  const before = structuredClone(state);
  const deleting = command({ command: "DELETE_REQUIREMENT", expectedDocumentRevision: 1, payload: { requirementId: ids.req, removeLinkIds: [ids.link] } });
  assert.throws(() => applyScopeCommand(state, 2, deleting, newId, context), /STALE_DOCUMENT_REVISION/);
  assert.throws(() => applyScopeCommand(state, 1, command({ command: "DELETE_REQUIREMENT", expectedDocumentRevision: 1, payload: { requirementId: ids.req, removeLinkIds: [] } }), newId, context), /DEPENDENCY_CONFLICT/);
  for (const reused of [ids.flow, ids.node, ids.req, ids.link]) {
    assert.throws(() => applyScopeCommand(state, 1, command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields }), () => reused, context), (error: unknown) => error instanceof GraphError && error.code === "INVALID_INPUT");
    assert.throws(() => applyChanges(state, 1, { commands: [{ command: { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "F", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, proposedIds: [reused] }], moves: [] }), (error: unknown) => error instanceof GraphError && error.code === "INVALID_INPUT" && error.details?.part === "commands" && error.details?.index === 0);
  }
  assert.deepEqual(state, before);
  const unlinked = applyScopeCommand(state, 1, command({ command: "DELETE_TRACE_LINK", expectedDocumentRevision: 1, payload: { linkId: ids.link } }), newId, context);
  assert.deepEqual(unlinked.document.traceLinks, {});
  assert.deepEqual(unlinked.retiredIds, [ids.link]);
  assert.deepEqual(unlinked.document.requirements, state.document.requirements);
  const deleted = applyScopeCommand(state, 1, deleting, newId, context);
  assert.deepEqual(deleted.document.requirements, {});
  assert.deepEqual(deleted.document.traceLinks, {});
  assert.deepEqual(new Set(deleted.retiredIds), new Set([ids.req, ids.link]));
  assert.deepEqual(new Set(deleted.document.retiredEntityIds), new Set([ids.req, ids.link]));
  assert.deepEqual(deleted.document.nodes, state.document.nodes);
  assert.deepEqual(deleted.layout, state.layout);
  assert.deepEqual(state, before);
});

test("chosen AI deletions include steps, their incident connections and explicit connection removals", () => {
  const edge = "50000000-0000-4000-8000-000000000001";
  const other = "50000000-0000-4000-8000-000000000002";
  const operations = [
    { id: "keep", edit: { command: "UPDATE_NODE", payload: { nodeId: ids.node } } },
    { id: "drop", edit: { command: "DELETE_NODES", payload: { flowId: ids.flow, nodeIds: [ids.node, ids.node], removeEdgeIds: [edge] } } },
    { id: "cut", edit: { command: "DELETE_EDGE", payload: { edgeId: other } } },
  ];
  assert.deepEqual(removedRecordIds(operations, ["keep", "drop", "cut"]), [ids.node, edge, other].sort());
  assert.deepEqual(removedRecordIds(operations, ["cut"]), [other], "an edge-only deletion still counts");
  assert.deepEqual(removedRecordIds(operations, ["keep"]), []);
  assert.deepEqual(removedRecordIds(operations, []), []);
  assert.deepEqual(removedRecordIds(operations, ["drop", "drop", "unknown"]), [ids.node, edge].sort());

  const document = graphDocument();
  document.nodes[ids.other] = { ...document.nodes[ids.node]!, id: ids.other };
  document.requirements[ids.req] = requirement();
  const secondRequirement = "50000000-0000-4000-8000-000000000003";
  document.requirements[secondRequirement] = requirement({ id: secondRequirement, displayId: "REQ-002" });
  const link = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "", reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
  document.traceLinks[ids.link] = link;
  document.traceLinks[edge] = { ...link, id: edge, requirementId: secondRequirement };
  document.traceLinks[other] = { ...link, id: other, nodeId: ids.other };
  const all = [...operations, { id: "drop-other", edit: { command: "DELETE_NODES", payload: { flowId: ids.flow, nodeIds: [ids.other], removeEdgeIds: [] } } }];
  assert.equal(incidentTraceLinks(document, removedRecordIds(all, all.map(({ id }) => id))).length, 3);
  assert.equal(incidentTraceLinks(document, removedRecordIds(all, ["drop", "drop", "unknown"])).length, 2, "count links, not nodes, and exclude unselected step deletions");
  assert.equal(incidentTraceLinks(document, removedRecordIds(all, ["cut"])).length, 0, "connection ids cannot count as step links");
});
