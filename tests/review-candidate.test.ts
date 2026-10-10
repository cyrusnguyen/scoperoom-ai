import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCandidate, agreedProjection } from "../src/features/reviews/domain/candidate.ts";
import { parseFreezeInput, parseWithdrawInput, REVIEW_BODY_LIMIT, WITHDRAW_BODY_LIMIT } from "../src/features/reviews/contracts/review.ts";
import { parseDraftPair, type SourceRef } from "../src/features/drafts/contracts/scope-document.ts";
import { projectErrors } from "../src/features/projects/contracts/errors.ts";
import { candidateFixture, ids, NOW, requirement, reviewIds, addFlow, addNode, addEdge } from "./support/review-fixtures.ts";

const flowFixture = () => { const input = candidateFixture(); input.draft.document.requirements = {}; addFlow(input.draft); return input; };
const hasError = (input: ReturnType<typeof candidateFixture>, code: string, targetId?: string | null) => {
  const check = checkCandidate(input);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(error => error.code === code && (targetId === undefined || error.targetId === targetId)), JSON.stringify(check));
};
const ref: SourceRef = { sourceVersionId: reviewIds.source, startLine: 1, endLine: 1, excerpt: "Evidence" };
const source = () => ({ id: reviewIds.source, sourceId: ids.other, kind: "USER_TEXT", sequence: 1, title: "Source", text: "Evidence\nSecond line", contentHash: "unused", codePointCount: 20, utf8ByteCount: 20, lineStarts: [0, 9], origin: null, createdBy: ids.actor, createdAt: NOW });

test("requirement-only and flow-only scope need neither scenarios nor verification", () => {
  for (const input of [candidateFixture(), flowFixture()]) assert.deepEqual(checkCandidate(input), { valid: true, errors: [], truncated: false });
});

const cases: Array<[string, (input: ReturnType<typeof candidateFixture>) => void, string]> = [
  ["no included content", input => { input.draft.document.requirements[ids.req]!.inclusion = "UNDECIDED"; }, "NO_INCLUDED_CONTENT"],
  ["missing requirement confirmation", input => { input.draft.document.requirements[ids.req]!.confirmation = null; }, "CONFIRMATION_REQUIRED"],
  ["stale requirement confirmation", input => { input.draft.document.requirements[ids.req]!.behaviourVersion++; }, "CONFIRMATION_REQUIRED"],
  ["missing flow confirmation", input => { addFlow(input.draft); input.draft.document.flows[ids.flow]!.confirmation = null; }, "CONFIRMATION_REQUIRED"],
  ["stale flow confirmation", input => { addFlow(input.draft); input.draft.document.flows[ids.flow]!.behaviourVersion++; }, "CONFIRMATION_REQUIRED"],
  ["unreviewed included link", input => { addFlow(input.draft); input.draft.document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "Supports", reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null }; }, "LINK_REVIEW_REQUIRED"],
  ["missing source", input => { input.draft.document.requirements[ids.req]!.sourceRefs = [ref]; }, "INVALID_CITATION"],
  ["empty included flow", input => { addFlow(input.draft); input.draft.document.nodes = {}; input.draft.document.edges = {}; input.draft.layout.positions = {}; }, "EMPTY_FLOW"],
  ["missing start", input => { addFlow(input.draft); input.draft.document.nodes[ids.node]!.kind = "DATA_STORE"; }, "NO_START"],
  ["missing outcome", input => { addFlow(input.draft); input.draft.document.nodes[reviewIds.outcome]!.kind = "DATA_STORE"; }, "NO_OUTCOME"],
  ["start incoming degree", input => { addFlow(input.draft); addEdge(input.draft, reviewIds.edge2, reviewIds.outcome, ids.node); }, "START_HAS_INCOMING"],
  ["outcome outgoing degree", input => { addFlow(input.draft); addEdge(input.draft, reviewIds.edge2, reviewIds.outcome, ids.node); }, "OUTCOME_HAS_OUTGOING"],
  ["action no exit", input => { addFlow(input.draft); addNode(input.draft, reviewIds.action, "ACTION"); addEdge(input.draft, reviewIds.edge2, ids.node, reviewIds.action); }, "ACTION_OUTGOING_COUNT"],
  ["decision one branch", input => { addFlow(input.draft); input.draft.document.nodes[ids.node]!.kind = "DECISION"; }, "DECISION_OUTGOING_COUNT"],
  ["unlabelled branch", input => { addFlow(input.draft); addNode(input.draft, reviewIds.action, "DECISION"); addEdge(input.draft, reviewIds.edge2, ids.node, reviewIds.action); addEdge(input.draft, ids.other, reviewIds.action, reviewIds.outcome); }, "UNLABELLED_BRANCH"],
  ["duplicate trimmed branches", input => { addFlow(input.draft); addNode(input.draft, reviewIds.action, "DECISION"); addEdge(input.draft, reviewIds.edge2, ids.node, reviewIds.action); addEdge(input.draft, ids.other, reviewIds.action, reviewIds.outcome, " Yes "); addEdge(input.draft, ids.link, reviewIds.action, ids.node, "Yes"); }, "DUPLICATE_BRANCH_LABEL"],
  ["unreachable node", input => { addFlow(input.draft); addNode(input.draft, reviewIds.action, "DATA_STORE"); addEdge(input.draft, reviewIds.edge2, reviewIds.action, reviewIds.outcome); }, "UNREACHABLE_FROM_START"],
  ["cannot reach outcome", input => { addFlow(input.draft); addNode(input.draft, reviewIds.action, "DATA_STORE"); addEdge(input.draft, reviewIds.edge2, ids.node, reviewIds.action); }, "CANNOT_REACH_OUTCOME"],
];
for (const [name, edit, code] of cases) test(name, () => { const input = candidateFixture(); edit(input); hasError(input, code); });

test("stale included endpoints require link review; background links do not", () => {
  const input = candidateFixture(); addFlow(input.draft);
  input.draft.document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "", reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  assert.equal(checkCandidate(input).valid, true);
  input.draft.document.nodes[ids.node]!.behaviourVersion++;
  hasError(input, "LINK_REVIEW_REQUIRED", ids.link);
  input.draft.document.flows[ids.flow]!.inclusion = "EXCLUDED";
  assert.equal(checkCandidate(input).valid, true);
  input.draft.document.flows[ids.flow]!.inclusion = "INCLUDED";
  input.draft.document.requirements[ids.req]!.inclusion = "UNDECIDED";
  assert.equal(checkCandidate(input).valid, true);
});

test("excluded incomplete graph saves and freezes, but malformed references anywhere fail", () => {
  const input = candidateFixture(); addFlow(input.draft);
  input.draft.document.flows[ids.flow]!.inclusion = "EXCLUDED";
  input.draft.document.flows[ids.flow]!.confirmation = null;
  input.draft.document.nodes[ids.node]!.kind = "ACTION";
  input.draft.document.edges = {};
  assert.doesNotThrow(() => parseDraftPair(input.draft.document, input.draft.layout));
  assert.equal(checkCandidate(input).valid, true);
  input.draft.document.nodes[ids.node]!.flowId = ids.other;
  hasError(input, "INVALID_DRAFT", null);
});

test("all captured citations are checked against exact versions, including background nodes/edges/requirements", () => {
  const input = candidateFixture(); addFlow(input.draft);
  input.evidence.push(source());
  input.draft.document.flows[ids.flow]!.inclusion = "EXCLUDED";
  input.draft.document.nodes[ids.node]!.sourceRefs = [ref];
  input.draft.document.edges[reviewIds.edge]!.sourceRefs = [ref];
  input.draft.document.requirements[ids.req]!.sourceRefs = [ref];
  assert.equal(checkCandidate(input).valid, true);
  input.evidence[0]!.text = "Different";
  const check = checkCandidate(input);
  assert.deepEqual(check.errors.filter(error => error.code === "INVALID_CITATION").map(error => error.targetId).sort(), [ids.node, ids.req, reviewIds.edge].sort());
  input.evidence[0]!.text = source().text;
  input.draft.document.requirements[ids.req]!.inclusion = "EXCLUDED";
  input.draft.document.flows[ids.flow]!.inclusion = "INCLUDED";
  input.draft.document.requirements[ids.req]!.sourceRefs = [{ ...ref, endLine: 3 }];
  hasError(input, "INVALID_CITATION", ids.req);
});

for (const kind of ["ACTION", "DATA_STORE"] as const) {
  for (const exitCount of [0, 1, 2]) test(kind + " requires exactly one outgoing connection: " + exitCount, () => {
    const input = flowFixture();
    addNode(input.draft, reviewIds.action, kind);
    input.draft.document.edges[reviewIds.edge]!.toId = reviewIds.action;
    if (exitCount >= 1) addEdge(input.draft, reviewIds.edge2, reviewIds.action, reviewIds.outcome);
    if (exitCount === 2) {
      addNode(input.draft, ids.other, "OUTCOME");
      addEdge(input.draft, ids.link, reviewIds.action, ids.other);
    }
    if (exitCount === 1) assert.deepEqual(checkCandidate(input), { valid: true, errors: [], truncated: false });
    else hasError(input, "ACTION_OUTGOING_COUNT", reviewIds.action);
  });
}

test("exit-bearing DECISION cycle is allowed; closed cycle fails", () => {
  const input = flowFixture();
  addNode(input.draft, reviewIds.action, "DECISION");
  input.draft.document.edges[reviewIds.edge]!.toId = reviewIds.action;
  addEdge(input.draft, reviewIds.edge2, reviewIds.action, reviewIds.action, "Retry");
  addEdge(input.draft, ids.other, reviewIds.action, reviewIds.outcome, "Finish");
  assert.equal(checkCandidate(input).valid, true);
  delete input.draft.document.edges[ids.other];
  hasError(input, "CANNOT_REACH_OUTCOME", reviewIds.action);
});

test("ordinary revisions, counters, stamps, owner, badges, display ids and layout are not semantic changes", () => {
  const input = candidateFixture(); addFlow(input.draft);
  const baseline = structuredClone(input.draft.document);
  input.draft.documentRevision++;
  input.draft.layoutRevision++;
  input.draft.layout.positions[ids.node]!.x = 40;
  input.draft.document.requirements[ids.req]!.version++;
  input.draft.document.requirements[ids.req]!.ownerId = ids.other;
  input.draft.document.requirements[ids.req]!.displayId = "REQ-002";
  input.draft.document.requirements[ids.req]!.origin = "IMPORTED";
  input.draft.document.requirements[ids.req]!.confirmation!.actorId = ids.other;
  input.draft.document.flows[ids.flow]!.confirmation!.confirmedAt = "2026-10-08T10:00:00.000Z";
  assert.deepEqual(agreedProjection(input.draft.document), agreedProjection(baseline));
  hasError({ ...input, baseline }, "NO_SEMANTIC_CHANGE", null);
  input.draft.document.requirements[ids.req]!.title = "Different";
  assert.equal(checkCandidate({ ...input, baseline }).valid, true);
  input.draft.document.requirements[ids.req]!.title = baseline.requirements[ids.req]!.title;
  input.draft.document.requirements[ids.req]!.behaviourVersion = 3;
  input.draft.document.requirements[ids.req]!.confirmation!.behaviourVersion = 3;
  hasError({ ...input, baseline }, "NO_SEMANTIC_CHANGE");
});

const semanticEdits: Array<[string, (input: ReturnType<typeof candidateFixture>) => void]> = [
  ["goal", input => { input.draft.document.projectGoal = "Deliver"; }],
  ["requirement title", input => { input.draft.document.requirements[ids.req]!.title += "!"; }],
  ["verification", input => { input.draft.document.requirements[ids.req]!.verificationMethod = { description: "Test", responsibleRole: "QA", reviewedBehaviourVersion: null, reviewedBy: null, reviewedAt: null }; }],
  ["citation", input => { input.draft.document.requirements[ids.req]!.sourceRefs = [ref]; }],
  ["flow title", input => { input.draft.document.flows[ids.flow]!.title += "!"; }],
  ["topology", input => { input.draft.document.edges[reviewIds.edge]!.toId = ids.node; }],
  ["node notes", input => { input.draft.document.nodes[ids.node]!.assumptionNotes = ["a", "b"]; }],
  ["link", input => { input.draft.document.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "Supports", reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW }; }],
  ["included removal", input => { delete input.draft.document.requirements[ids.req]; }],
  ["move out of scope", input => { input.draft.document.requirements[ids.req]!.inclusion = "EXCLUDED"; }],
];
for (const [name, edit] of semanticEdits) test(`projection changes for ${name}`, () => { const input = candidateFixture(); addFlow(input.draft); const before = agreedProjection(input.draft.document); edit(input); assert.notDeepEqual(agreedProjection(input.draft.document), before); });

test("projection sorts maps and unordered citations, preserves prose and ordered notes", () => {
  const input = candidateFixture(); addFlow(input.draft);
  const second = { ...ref, startLine: 2, endLine: 2, excerpt: "Second" };
  input.draft.document.requirements[ids.req]!.sourceRefs = [second, ref];
  input.draft.document.nodes[ids.node]!.assumptionNotes = ["first", "second"];
  const before = agreedProjection(input.draft.document);
  input.draft.document.nodes = Object.fromEntries(Object.entries(input.draft.document.nodes).reverse());
  input.draft.document.requirements[ids.req]!.sourceRefs.reverse();
  assert.deepEqual(agreedProjection(input.draft.document), before);
  input.draft.document.nodes[ids.node]!.assumptionNotes.reverse();
  assert.notDeepEqual(agreedProjection(input.draft.document), before);
  input.draft.document.nodes[ids.node]!.assumptionNotes.reverse();
  input.draft.document.requirements[ids.req]!.title += " ";
  assert.notDeepEqual(agreedProjection(input.draft.document), before);
});

test("excluded and undecided-only edits never change agreed projection", () => {
  const input = candidateFixture(); addFlow(input.draft);
  input.draft.document.flows[ids.flow]!.inclusion = "EXCLUDED";
  input.draft.document.requirements[ids.other] = requirement({ id: ids.other, displayId: "REQ-002", inclusion: "UNDECIDED" });
  const before = agreedProjection(input.draft.document);
  input.draft.document.flows[ids.flow]!.title = "Other";
  input.draft.document.nodes[ids.node]!.label = "Changed";
  input.draft.document.edges[reviewIds.edge]!.condition = "Changed";
  input.draft.document.requirements[ids.other]!.title = "Changed";
  assert.deepEqual(agreedProjection(input.draft.document), before);
});

test("candidate errors are deterministic unique pairs, bounded at 50 with truncation", () => {
  const input = candidateFixture(); input.draft.document.requirements = {};
  for (let i = 1; i <= 60; i++) {
    const id = `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    input.draft.document.requirements[id] = requirement({ id, displayId: `REQ-${String(i).padStart(3, "0")}`, inclusion: "INCLUDED" });
  }
  const check = checkCandidate(input);
  assert.equal(check.valid, false); assert.equal(check.truncated, true); assert.equal(check.errors.length, 50);
  input.draft.document.requirements = Object.fromEntries(Object.entries(input.draft.document.requirements).reverse());
  assert.deepEqual(checkCandidate(input), check);
  for (const id of Object.keys(input.draft.document.requirements).slice(0, 10)) delete input.draft.document.requirements[id];
  assert.equal(checkCandidate(input).truncated, false);
});

const guards = { expectedDocumentRevision: 1, expectedLayoutRevision: 1, expectedParentSnapshotId: null, expectedApprovalPolicyVersion: 1 };
test("freeze parser accepts only exact guards and rejects replacement/intent/authority fields", () => {
  assert.deepEqual(parseFreezeInput(guards), guards);
  assert.equal(parseFreezeInput({ ...guards, expectedParentSnapshotId: ids.other }).expectedParentSnapshotId, ids.other);
  for (const field of ["documentJson", "layoutJson", "evidenceManifest", "valid", "agreementIntent", "requestResolution", "actorId", "designatedApproverId"])
    assert.throws(() => parseFreezeInput({ ...guards, [field]: field === "agreementIntent" ? "EXCLUSION_ONLY" : {} }), /INVALID_INPUT/);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, "1", null]) assert.throws(() => parseFreezeInput({ ...guards, expectedDocumentRevision: value }), /INVALID_INPUT/);
  assert.throws(() => parseFreezeInput({ ...guards, expectedParentSnapshotId: "bad" }), /INVALID_INPUT/);
  assert.throws(() => parseFreezeInput({ expectedDocumentRevision: 1 }), /INVALID_INPUT/);
  assert.equal(REVIEW_BODY_LIMIT, 4 * 1024);
});
test("withdraw parser permits 4000 code points with a 32KiB body cap, strict review guards and reasons", () => {
  const input = { expectedReviewVersion: 1, reason: "😀".repeat(4000) };
  assert.deepEqual(parseWithdrawInput(input), input);
  assert.equal(WITHDRAW_BODY_LIMIT, 32 * 1024);
  for (const reason of ["", " ", "x".repeat(4001), "\uD800", "\u0000"]) assert.throws(() => parseWithdrawInput({ ...input, reason }), /INVALID_INPUT/);
  assert.throws(() => parseWithdrawInput({ ...input, actorId: ids.actor }), /INVALID_INPUT/);
  assert.throws(() => parseWithdrawInput({ ...input, expectedReviewVersion: 0 }), /INVALID_INPUT/);
});
test("review errors use existing project HTTP conventions", () => {
  assert.equal(projectErrors.CANDIDATE_INVALID.status, 422);
  assert.equal(projectErrors.ACTIVE_REVIEW_EXISTS.status, 409);
  assert.equal(projectErrors.REVIEW_POLICY_CHANGED.status, 409);
  assert.equal(projectErrors.UNAVAILABLE.status, 503);
});

test("recreating identical links with new record IDs cannot manufacture agreed change", () => {
  const input = candidateFixture(); addFlow(input.draft);
  const link = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: "Start", reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1, reviewedBy: ids.actor, reviewedAt: NOW };
  input.draft.document.traceLinks[ids.link] = link;
  input.draft.document.traceLinks[ids.other] = { ...link, id: ids.other, nodeId: reviewIds.outcome, explanation: "Outcome" };
  const baseline = structuredClone(input.draft.document);
  input.draft.document.traceLinks = { [ids.link]: { ...link, nodeId: reviewIds.outcome, explanation: "Outcome" }, [ids.other]: { ...link, id: ids.other } };
  assert.deepEqual(agreedProjection(input.draft.document), agreedProjection(baseline));
  hasError({ ...input, baseline }, "NO_SEMANTIC_CHANGE");
  input.draft.document.traceLinks[ids.link]!.explanation += "!";
  assert.notDeepEqual(agreedProjection(input.draft.document), agreedProjection(baseline));
});

test("flow membership is included meaning even when entity fields and IDs stay the same", () => {
  const input = candidateFixture(); addFlow(input.draft);
  input.draft.document.flows[ids.other] = { ...input.draft.document.flows[ids.flow]!, id: ids.other };
  const baseline = structuredClone(input.draft.document);
  for (const node of Object.values(input.draft.document.nodes)) node.flowId = ids.other;
  for (const edge of Object.values(input.draft.document.edges)) edge.flowId = ids.other;
  assert.notDeepEqual(agreedProjection(input.draft.document), agreedProjection(baseline));
});
