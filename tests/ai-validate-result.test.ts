import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AI_LIMITS } from "../src/features/proposals/contracts/tasks.ts";
import { jsonbTextBytes } from "../src/features/proposals/domain/capture.ts";
import { NO_CHANGE, ResultError, validateResult } from "../src/features/proposals/domain/validate-result.ts";
import { edgeOp, flowOp, goodGenerate, nodeOp, proposal, resultFixture } from "./support/ai-results.ts";

const f = resultFixture();
const generate = f.generate();
const improve = f.improve();
const refuses = (capture: typeof generate, output: unknown, reason: string) =>
  assert.throws(() => validateResult(capture, output), (error) => error instanceof ResultError && error.reason === reason, reason);
const update = (id: string, nodeId: string, dependsOn: string[] = []) => ({ id, dependsOn, edit: { command: "UPDATE_NODE", payload: { nodeId, label: "Renamed" } } });
const del = (id: string, nodeIds: string[], removeEdgeIds: string[], flowId = f.flowId) => ({ id, dependsOn: [], edit: { command: "DELETE_NODES", payload: { flowId, nodeIds, removeEdgeIds } } });

test("a complete Generate proposal validates and is returned normalized", () => {
  const output = goodGenerate(f.sourceVersionId);
  assert.deepEqual(validateResult(generate, output), output);
  assert.deepEqual(validateResult(generate, JSON.parse(JSON.stringify(output))), output);
});

test("clarification is valid and carries only its message; extra keys, wrong kind and wrong version are refused", () => {
  assert.deepEqual(validateResult(generate, { schemaVersion: 1, kind: "clarification", message: "Which payment provider?" }), { schemaVersion: 1, kind: "clarification", message: "Which payment provider?" });
  refuses(generate, { schemaVersion: 1, kind: "clarification", message: "x", operations: [] }, "SHAPE");
  refuses(generate, { schemaVersion: 1, kind: "clarification", message: "  " }, "SHAPE");
  refuses(generate, { schemaVersion: 2, kind: "clarification", message: "x" }, "SCHEMA_VERSION");
  refuses(generate, { schemaVersion: 1, kind: "answer", message: "x" }, "KIND");
  for (const output of [null, [], "text", 7, { schemaVersion: 1, kind: "proposal" }, { ...goodGenerate(f.sourceVersionId), extra: true }]) assert.throws(() => validateResult(generate, output), ResultError);
});

test("an empty Improve proposal is a no-change clarification, but an empty Generate proposal is refused", () => {
  assert.deepEqual(validateResult(improve, proposal([])), NO_CHANGE);
  assert.equal(NO_CHANGE.kind, "clarification");
  refuses(generate, proposal([]), "EMPTY_PROPOSAL");
});

test("operations are a closed union restricted to the task's edits", () => {
  refuses(generate, proposal([update("op1", f.ids.b)]), "SHAPE"); // Generate cannot edit existing steps
  refuses(improve, proposal([flowOp()]), "SHAPE"); // Improve never creates or edits whole flows
  refuses(generate, proposal([{ ...flowOp(), edit: { ...flowOp().edit, command: "DELETE_FLOW" } }]), "SHAPE");
  refuses(generate, proposal([{ ...flowOp(), extra: 1 }]), "SHAPE");
  refuses(generate, proposal([flowOp("op1", "flow1", [])].map((op) => ({ ...op, edit: { ...op.edit, payload: { ...op.edit.payload, extra: 1 } } }))), "SHAPE");
  refuses(generate, proposal([{ ...flowOp(), edit: { ...flowOp().edit, payload: { ref: "flow1", title: "", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } } }]), "SHAPE");
  refuses(generate, proposal([{ ...flowOp(), edit: { ...flowOp().edit, payload: { ref: "flow1", title: "T", purpose: "", classification: "OTHER", inclusion: "UNDECIDED" } } }]), "SHAPE");
  refuses(improve, proposal([{ id: "op1", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: f.ids.b } } }]), "EMPTY_UPDATE");
});

test("operation and reference identifiers are bounded local refs, and every entity id is a captured UUID or a local ref", () => {
  refuses(generate, proposal([flowOp("Op One")]), "REF");
  refuses(generate, proposal([flowOp("op1", "x".repeat(33))]), "REF");
  refuses(generate, proposal([flowOp("op1", "flow1"), flowOp("op1", "flow2")]), "DUPLICATE_OPERATION");
  refuses(generate, proposal([flowOp("op1", "flow1"), nodeOp("op2", "flow1", "flow1", ["op1"])]), "DUPLICATE_REF");
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "not a uuid or ref!", ["op1"])]), "SHAPE");
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op9"])]), "DEPENDS_ON");
  refuses(generate, proposal([flowOp("op1", "flow1", ["op1"])]), "DEPENDS_ON");
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op1", "op1"])]), "DEPENDS_ON");
});

test("dependsOn must be acyclic and an operation must depend on whatever creates what it references", () => {
  refuses(generate, proposal([flowOp("op1", "flow1", ["op2"]), nodeOp("op2", "n1", "flow1", ["op1"])]), "CYCLE");
  refuses(generate, proposal([flowOp("op1", "flow1", ["op3"]), nodeOp("op2", "n1", "flow1", ["op1"]), nodeOp("op3", "n2", "flow1", ["op2"])]), "CYCLE");
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", [])]), "REFERENCE"); // a node without its flow's creator
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op1"]), nodeOp("op3", "n2", "flow1", ["op1"]), edgeOp("op4", "flow1", "n1", "n2", ["op2"])]), "REFERENCE"); // missing the n2 creator
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "ghost", ["op1"])]), "REFERENCE"); // never created
  assert.doesNotThrow(() => validateResult(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op1"]), nodeOp("op3", "n2", "flow1", ["op2"]), edgeOp("op4", "flow1", "n1", "n2", ["op3"])]))); // transitive dependency is enough
});

test("Generate may create only one new flow group and never name captured ids", () => {
  refuses(generate, proposal([flowOp(), flowOp("op2", "flow2")]), "FLOW_GROUP");
  refuses(generate, proposal([nodeOp("op1", "n1", f.flowId, [])]), "OUT_OF_SCOPE"); // an existing flow
  refuses(generate, proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op1"]), edgeOp("op3", "flow1", "n1", f.ids.a, ["op2"])]), "OUT_OF_SCOPE"); // an existing step
  refuses(generate, proposal([nodeOp("op1", "n1", "flow1", [])]), "REFERENCE");
});

test("Improve is confined to the selection, its incident edges and the read-only boundary", () => {
  const ok = proposal([update("op1", f.ids.b), { id: "op2", dependsOn: [], edit: { command: "UPDATE_EDGE", payload: { edgeId: f.edges.e2, condition: "when paid" } } }]);
  assert.equal(validateResult(improve, ok).kind, "proposal");
  refuses(improve, proposal([update("op1", f.ids.a)]), "OUT_OF_SCOPE"); // boundary neighbour is read-only
  refuses(improve, proposal([update("op1", f.ids.d)]), "OUT_OF_SCOPE"); // the other boundary neighbour
  refuses(improve, proposal([update("op1", f.ids.foreign)]), "OUT_OF_SCOPE");
  refuses(improve, proposal([update("op1", f.ids.stray)]), "OUT_OF_SCOPE"); // another flow
  refuses(improve, proposal([{ id: "op1", dependsOn: [], edit: { command: "DELETE_EDGE", payload: { edgeId: randomUUID() } } }]), "OUT_OF_SCOPE");
  refuses(f.improve([f.ids.b]), proposal([{ id: "op1", dependsOn: [], edit: { command: "DELETE_EDGE", payload: { edgeId: f.edges.e3 } } }]), "OUT_OF_SCOPE"); // e3 (c-d) is not incident to b
});

test("Improve edges may touch selected steps, boundary neighbours and new steps, but not stay outside the selection", () => {
  const newNode = nodeOp("op1", "n1", f.flowId, []);
  assert.equal(validateResult(improve, proposal([newNode, edgeOp("op2", f.flowId, f.ids.b, "n1", ["op1"]), edgeOp("op3", f.flowId, f.ids.a, "n1", ["op1"])])).kind, "proposal"); // a is a boundary neighbour
  refuses(improve, proposal([edgeOp("op1", f.flowId, f.ids.a, f.ids.d, [])]), "OUT_OF_SCOPE"); // a and d are both read-only neighbours
  refuses(improve, proposal([nodeOp("op1", "n1", f.otherFlowId, [])]), "OUT_OF_SCOPE"); // another flow
  const boundaryOnly = f.improve([f.ids.b]); // boundary is a and c: an edge between them lies outside the selection
  refuses(boundaryOnly, proposal([edgeOp("op1", f.flowId, f.ids.a, f.ids.c, [])]), "OUT_OF_SCOPE");
  refuses(improve, proposal([newNode, edgeOp("op2", f.flowId, f.ids.b, "n1", [])]), "REFERENCE"); // edge without the creator dependency
  const reconnect = (nodeId: string) => ({ id: "op1", dependsOn: [], edit: { command: "RECONNECT_EDGE", payload: { edgeId: f.edges.e2, fromId: f.ids.b, toId: nodeId } } });
  assert.equal(validateResult(improve, proposal([reconnect(f.ids.a)])).kind, "proposal");
  assert.equal(validateResult(improve, proposal([reconnect(f.ids.d)])).kind, "proposal"); // d is a captured neighbour
  refuses(improve, proposal([reconnect(f.ids.stray)]), "OUT_OF_SCOPE");
  refuses(improve, proposal([reconnect(f.ids.foreign)]), "OUT_OF_SCOPE");
});

test("deleting steps requires exactly their incident edges, and conflicting operations on the same entity are refused", () => {
  assert.equal(validateResult(improve, proposal([del("op1", [f.ids.b], [f.edges.e1, f.edges.e2])])).kind, "proposal");
  refuses(improve, proposal([del("op1", [f.ids.b], [f.edges.e1])]), "INCOMPLETE_DELETE"); // leaves e2 dangling
  refuses(improve, proposal([del("op1", [f.ids.b], [f.edges.e1, f.edges.e2, f.edges.e3])]), "INCOMPLETE_DELETE"); // names an edge not incident to b
  refuses(improve, proposal([del("op1", [f.ids.a], [f.edges.e1])]), "OUT_OF_SCOPE"); // boundary step
  refuses(improve, proposal([del("op1", [], [])]), "EMPTY_DELETE");
  refuses(improve, proposal([del("op1", [f.ids.b], [f.edges.e1, f.edges.e2]), update("op2", f.ids.b)]), "CONFLICT");
  refuses(improve, proposal([del("op1", [f.ids.b], [f.edges.e1, f.edges.e2]), { id: "op2", dependsOn: [], edit: { command: "DELETE_EDGE", payload: { edgeId: f.edges.e2 } } }]), "CONFLICT");
  refuses(improve, proposal([del("op1", [f.ids.b], [f.edges.e1, f.edges.e2]), nodeOp("op2", "n1", f.flowId, []), edgeOp("op3", f.flowId, f.ids.b, "n1", ["op2"])]), "CONFLICT"); // an edge to a deleted step
  refuses(improve, proposal([update("op1", f.ids.b), update("op2", f.ids.b)]), "CONFLICT");
  refuses(improve, proposal([del("op1", [f.ids.b, f.ids.b], [f.edges.e1, f.edges.e2])]), "DUPLICATE_ID");
  const wide = f.improve([f.ids.a, f.ids.b, f.ids.c, f.ids.d]);
  assert.equal(validateResult(wide, proposal([del("op1", [f.ids.a, f.ids.b, f.ids.c, f.ids.d], [f.edges.e1, f.edges.e2, f.edges.e3])])).kind, "proposal");
});

test("graph, operation, dependency, assumption and byte limits reject instead of truncating", () => {
  const nodes = (count: number) => Array.from({ length: count }, (_, index) => nodeOp(`op${index + 2}`, `n${index}`, "flow1", ["op1"]));
  assert.equal(validateResult(generate, proposal([flowOp(), ...nodes(AI_LIMITS.maxGraphNodes)])).kind, "proposal");
  refuses(generate, proposal([flowOp(), ...nodes(AI_LIMITS.maxGraphNodes + 1)]), "GRAPH_LIMIT");
  const edges = (count: number) => Array.from({ length: count }, (_, index) => edgeOp(`e${index}`, "flow1", "n0", "n1", ["op2", "op3"]));
  assert.equal(validateResult(generate, proposal([flowOp(), ...nodes(2), ...edges(AI_LIMITS.maxGraphEdges)])).kind, "proposal");
  refuses(generate, proposal([flowOp(), ...nodes(2), ...edges(AI_LIMITS.maxGraphEdges + 1)]), "GRAPH_LIMIT");
  refuses(generate, proposal(Array.from({ length: AI_LIMITS.operations + 1 }, (_, index) => flowOp(`op${index}`, `f${index}`))), "OPERATIONS");
  refuses(generate, proposal([flowOp("op1", "flow1", Array.from({ length: AI_LIMITS.dependsOn + 1 }, (_, index) => `d${index}`))]), "DEPENDS_ON");
  refuses(generate, goodWith({ assumptions: Array.from({ length: AI_LIMITS.assumptions + 1 }, () => "a") }), "ASSUMPTIONS");
  assert.equal(validateResult(generate, goodWith({ assumptions: ["a".repeat(AI_LIMITS.assumptionCodePoints)] })).kind, "proposal");
  refuses(generate, goodWith({ assumptions: ["a".repeat(AI_LIMITS.assumptionCodePoints + 1)] }), "SHAPE");
  refuses(generate, goodWith({ assumptions: [" "] }), "SHAPE");
  const huge = { schemaVersion: 1, kind: "clarification", message: "x".repeat(AI_LIMITS.resultBytes) };
  assert.ok(jsonbTextBytes(huge) > AI_LIMITS.resultBytes);
  refuses(generate, huge, "RESULT_BYTES");
});

function goodWith(extra: Record<string, unknown>) { return { ...goodGenerate(f.sourceVersionId), ...extra }; }

test("the byte cap uses the PostgreSQL JSONB rendering, not the wire length", () => {
  // JSONB renders `{"a": 1}` with one space after a colon and comma, so many small members cost more than their compact JSON.
  const message = "m".repeat(AI_LIMITS.assumptionCodePoints);
  const many = proposal([flowOp()], { assumptions: Array.from({ length: AI_LIMITS.assumptions }, () => message) });
  assert.ok(jsonbTextBytes(many) < AI_LIMITS.resultBytes);
  assert.equal(validateResult(generate, many).kind, "proposal");
});

test("citations name a captured source and an exact line range with its exact text", () => {
  const cite = (over: Record<string, unknown>) => goodWith({ citations: [{ sourceVersionId: f.sourceVersionId, startLine: 1, endLine: 1, excerpt: "line one", ...over }] });
  assert.equal(validateResult(generate, cite({})).kind, "proposal");
  assert.equal(validateResult(generate, cite({ startLine: 1, endLine: 3, excerpt: "line one\nline two\nline three" })).kind, "proposal");
  refuses(generate, cite({ sourceVersionId: randomUUID() }), "CITATION_SOURCE"); // not a captured (same-project) source
  refuses(generate, cite({ excerpt: "line two" }), "CITATION_EXCERPT");
  refuses(generate, cite({ excerpt: "line one " }), "CITATION_EXCERPT");
  refuses(generate, cite({ startLine: 0 }), "CITATION_RANGE");
  refuses(generate, cite({ startLine: 2, endLine: 1 }), "CITATION_RANGE");
  refuses(generate, cite({ endLine: 4 }), "CITATION_RANGE");
  refuses(generate, cite({ startLine: 1.5 }), "CITATION_RANGE");
  refuses(generate, cite({ extra: 1 }), "SHAPE");
  refuses(generate, cite({ excerpt: "" }), "SHAPE");
  refuses(generate, goodWith({ citations: Array.from({ length: AI_LIMITS.citations + 1 }, () => ({ sourceVersionId: f.sourceVersionId, startLine: 1, endLine: 1, excerpt: "line one" })) }), "CITATIONS");
  refuses({ ...f.generate(), sources: [] }, goodGenerate(f.sourceVersionId), "CITATION_SOURCE"); // nothing was captured to cite
});

test("Generate refuses a result that would exceed the document's flow, node or edge capacity", () => {
  const full = f.generate();
  const crowded = { ...full, graph: { ...full.graph, flows: Array.from({ length: 5 }, (_, index) => ({ ...full.graph.flows[0]!, id: randomUUID(), title: `F${index}` })) } };
  refuses(crowded, proposal([flowOp()]), "DOCUMENT_LIMIT");
});
