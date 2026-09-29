import assert from "node:assert/strict";
import test from "node:test";
import type { GraphCommand } from "../src/features/drafts/contracts/commands.ts";
import { LIMITS, emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { applyGraphCommand, dependencyPlan, GraphError, type Draft } from "../src/features/drafts/domain/graph.ts";

/** Deterministic server IDs for tests: 00000000-0000-4000-8000-000000000001, …0002, … */
function ids(start = 1) {
  let next = start;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

type Step = { draft: Draft; revision: number };

/** Applies commands in order, advancing the document revision the way the server does. */
function run(commands: ((state: Step) => GraphCommand)[], newId = ids()) {
  let state: Step = { draft: emptyDraft(), revision: 1 };
  const results = [];
  for (const make of commands) {
    const applied = applyGraphCommand(state.draft, state.revision, make(state), newId);
    results.push(applied);
    state = {
      draft: { document: applied.document, layout: applied.layout },
      revision: state.revision + (applied.documentChanged ? 1 : 0),
    };
  }
  return { state, results };
}

const createFlow = ({ revision }: Step): GraphCommand => ({
  commandSchemaVersion: 1,
  command: "CREATE_FLOW",
  expectedDocumentRevision: revision,
  payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" },
});
const flowOf = ({ draft }: Step, index = 0) => Object.keys(draft.document.flows)[index]!;
const nodesOf = ({ draft }: Step) => Object.keys(draft.document.nodes);
const addNode = (label: string, flow = 0) => (state: Step): GraphCommand => ({
  commandSchemaVersion: 1,
  command: "ADD_NODE",
  expectedDocumentRevision: state.revision,
  payload: { flowId: flowOf(state, flow), kind: "ACTION", label, description: "", actorLabel: "" },
});
const connect = (from: number, to: number) => (state: Step): GraphCommand => ({
  commandSchemaVersion: 1,
  command: "ADD_EDGE",
  expectedDocumentRevision: state.revision,
  payload: { flowId: flowOf(state), fromId: nodesOf(state)[from]!, toId: nodesOf(state)[to]!, condition: "" },
});
const failsWith = (code: string) => (error: unknown) => error instanceof GraphError && error.code === code;

test("an incomplete exploratory flow saves: no start, no outcome, isolated steps", () => {
  const { state, results } = run([createFlow, addNode("Browse"), addNode("Think")]);
  assert.equal(Object.keys(state.draft.document.nodes).length, 2);
  assert.deepEqual(results.map((result) => result.layoutChanged), [true, true, true]);
  const flow = state.draft.document.flows[flowOf(state)]!;
  assert.equal(state.draft.layout.directions[flow.id], "TB");
  assert.deepEqual([flow.version, flow.behaviourVersion], [3, 3]);
});

test("new nodes get a server position below the last one, and existing positions never move", () => {
  const { state } = run([createFlow, addNode("One"), addNode("Two"), addNode("Three")]);
  const positions = nodesOf(state).map((id) => state.draft.layout.positions[id]);
  assert.deepEqual(positions, [
    { x: 0, y: 0, version: 1 },
    { x: 0, y: 160, version: 1 },
    { x: 0, y: 320, version: 1 },
  ]);
});

test("a label edit guards the node version, bumps node and parent flow once, and leaves the layout alone", () => {
  const { state } = run([createFlow, addNode("Pay")]);
  const nodeId = nodesOf(state)[0]!;
  const applied = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "UPDATE_NODE",
    expectedEntityVersion: 1,
    payload: { nodeId, label: "Pay now" },
  }, ids(90));
  assert.equal(applied.layoutChanged, false);
  assert.equal(applied.document.nodes[nodeId]!.label, "Pay now");
  assert.deepEqual(applied.versions, { [nodeId]: 2, [flowOf(state)]: 3 });
  assert.deepEqual(applied.layout, state.draft.layout);
  assert.throws(() => applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "UPDATE_NODE",
    expectedEntityVersion: 2,
    payload: { nodeId, label: "Late" },
  }, ids(90)), (error: unknown) => failsWith("STALE_ENTITY_VERSION")(error) && (error as GraphError).details?.currentVersion === 1);
});

test("an identical update is an effective no-op", () => {
  const { state } = run([createFlow, addNode("Pay")]);
  const applied = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "UPDATE_NODE",
    expectedEntityVersion: 1,
    payload: { nodeId: nodesOf(state)[0]!, label: "Pay" },
  }, ids(90));
  assert.equal(applied.documentChanged, false);
  assert.deepEqual(applied.versions, {});
});

test("topology commands need the exact document revision", () => {
  const { state } = run([createFlow]);
  assert.throws(() => applyGraphCommand(
    state.draft,
    state.revision,
    addNode("Late")({ ...state, revision: state.revision - 1 }),
    ids(90),
  ), failsWith("STALE_DOCUMENT_REVISION"));
});

test("edges must stay inside one flow and name existing nodes", () => {
  const { state } = run([createFlow, addNode("A"), createFlow, addNode("B", 1)]);
  const [a, b] = nodesOf(state);
  const edge = (toId: string): GraphCommand => ({
    commandSchemaVersion: 1,
    command: "ADD_EDGE",
    expectedDocumentRevision: state.revision,
    payload: { flowId: flowOf(state), fromId: a!, toId, condition: "" },
  });
  assert.throws(() => applyGraphCommand(state.draft, state.revision, edge(b!), ids(90)), failsWith("INVALID_INPUT"));
  assert.throws(() => applyGraphCommand(state.draft, state.revision, edge("00000000-0000-4000-8000-0000000000ff"), ids(90)), failsWith("INVALID_INPUT"));
});

test("cycles and self-loops are allowed while exploring", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1), connect(1, 0), connect(0, 0)]);
  assert.equal(Object.keys(state.draft.document.edges).length, 3);
});

test("deleting nodes needs the exact incident-edge plan, retires the IDs and drops their positions", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), addNode("C"), connect(0, 1), connect(1, 2)]);
  const flowId = flowOf(state);
  const [, b] = nodesOf(state);
  const plan = dependencyPlan(state.draft.document, flowId, [b!]);
  assert.equal(plan.edgeIds.length, 2);
  const remove = (removeEdgeIds: string[]): GraphCommand => ({
    commandSchemaVersion: 1,
    command: "DELETE_NODES",
    expectedDocumentRevision: state.revision,
    payload: { flowId, nodeIds: [b!], removeEdgeIds },
  });
  assert.throws(() => applyGraphCommand(state.draft, state.revision, remove(plan.edgeIds.slice(1)), ids(90)), failsWith("DEPENDENCY_CONFLICT"));
  const applied = applyGraphCommand(state.draft, state.revision, remove([...plan.edgeIds].reverse()), ids(90));
  assert.equal(applied.document.nodes[b!], undefined);
  assert.equal(applied.layout.positions[b!], undefined);
  assert.deepEqual(applied.retiredIds.sort(), [b!, ...plan.edgeIds].sort());
  assert.deepEqual(applied.document.retiredEntityIds, [...applied.document.retiredEntityIds].sort());
  assert.throws(() => applyGraphCommand({ document: applied.document, layout: applied.layout }, state.revision + 1, {
    commandSchemaVersion: 1,
    command: "UPDATE_NODE",
    expectedEntityVersion: 1,
    payload: { nodeId: b!, label: "Back" },
  }, ids(90)), (error: unknown) => failsWith("STALE_ENTITY_VERSION")(error) && (error as GraphError).details?.currentVersion === null);
});

test("retired IDs are never allocated again", () => {
  const { state } = run([createFlow, addNode("A")]);
  const nodeId = nodesOf(state)[0]!;
  const removed = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "DELETE_NODES",
    expectedDocumentRevision: state.revision,
    payload: { flowId: flowOf(state), nodeIds: [nodeId], removeEdgeIds: [] },
  }, ids(90));
  assert.throws(() => applyGraphCommand(
    removed,
    state.revision + 1,
    addNode("Again")({ draft: removed, revision: state.revision + 1 }),
    () => nodeId,
  ), /ID_COLLISION/);
});

test("duplicating a flow allocates fresh identities and copies topology, positions and direction", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1)]);
  const source = flowOf(state);
  const applied = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "DUPLICATE_FLOW",
    expectedDocumentRevision: state.revision,
    payload: { flowId: source },
  }, ids(90));
  const copyId = applied.createdIds[0]!;
  const copy = applied.document.flows[copyId]!;
  assert.equal(copy.title, "Copy of Checkout");
  assert.deepEqual([copy.version, copy.behaviourVersion, copy.confirmation], [1, 1, null]);
  const copiedNodes = Object.values(applied.document.nodes).filter((node) => node.flowId === copyId);
  const copiedEdge = Object.values(applied.document.edges).find((edge) => edge.flowId === copyId)!;
  assert.equal(copiedNodes.length, 2);
  assert(copiedNodes.every((node) => !state.draft.document.nodes[node.id] && node.version === 1));
  assert(copiedNodes.some((node) => node.id === copiedEdge.fromId) && copiedNodes.some((node) => node.id === copiedEdge.toId));
  assert.deepEqual(copiedNodes.map((node) => applied.layout.positions[node.id]), [
    { x: 0, y: 0, version: 1 },
    { x: 0, y: 160, version: 1 },
  ]);
  assert.deepEqual(applied.document.flows[source], state.draft.document.flows[source]);
});

test("duplicating a flow carries a source edge's saved connection sides to the copy's edge id", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1)]);
  const [a, b] = nodesOf(state);
  const source = flowOf(state);
  const edgeId = Object.keys(state.draft.document.edges)[0]!;
  const withSides = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "right", toSide: "left" },
  }, ids(89));
  const applied = applyGraphCommand(withSides, state.revision, {
    commandSchemaVersion: 1, command: "DUPLICATE_FLOW", expectedDocumentRevision: state.revision, payload: { flowId: source },
  }, ids(90));
  const copyId = applied.createdIds[0]!;
  const copiedEdge = Object.values(applied.document.edges).find((edge) => edge.flowId === copyId)!;
  assert.notEqual(copiedEdge.id, edgeId);
  assert.deepEqual(applied.layout.edgeSides[copiedEdge.id], { from: "right", to: "left" });
  // The source edge keeps its own entry, unaffected.
  assert.deepEqual(applied.layout.edgeSides[edgeId], { from: "right", to: "left" });
});

test("duplicating a maximum-length title refuses instead of truncating saved text", () => {
  const { state } = run([createFlow]);
  const source = flowOf(state);
  state.draft.document.flows[source]!.title = "🧭".repeat(LIMITS.title);
  assert.throws(() => applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1,
    command: "DUPLICATE_FLOW",
    expectedDocumentRevision: state.revision,
    payload: { flowId: source },
  }, ids(90)), failsWith("LIMIT_EXCEEDED"));
  assert.equal(state.draft.document.flows[source]!.title, "🧭".repeat(LIMITS.title));
});

test("deleting a flow removes its nodes, edges, positions, direction and any saved connection sides together", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1)]);
  const flowId = flowOf(state);
  const [a, b] = nodesOf(state);
  const edgeId = Object.keys(state.draft.document.edges)[0]!;
  const withSides = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "right", toSide: "left" },
  }, ids(89));
  const plan = dependencyPlan(withSides.document, flowId);
  const applied = applyGraphCommand(withSides, state.revision, {
    commandSchemaVersion: 1,
    command: "DELETE_FLOW",
    expectedDocumentRevision: state.revision,
    payload: { flowId, removeNodeIds: plan.nodeIds, removeEdgeIds: plan.edgeIds },
  }, ids(90));
  assert.deepEqual(applied.document.flows, {});
  assert.deepEqual(applied.layout, { schemaVersion: 1, positions: {}, directions: {}, edgeSides: {} });
  assert.equal(applied.layoutChanged, true);
  assert.equal(applied.document.retiredEntityIds.length, 4);
});

test("count limits fail without partial effects", () => {
  const five = run([createFlow, createFlow, createFlow, createFlow, createFlow]);
  assert.throws(() => applyGraphCommand(five.state.draft, five.state.revision, createFlow(five.state), ids(90)), failsWith("LIMIT_EXCEEDED"));
  assert.equal(Object.keys(five.state.draft.document.flows).length, 5);
});

test("reconnect keeps the edge ID, and moving an edge endpoint into another flow is refused", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), addNode("C"), connect(0, 1), createFlow, addNode("Elsewhere", 1)]);
  const [a, , c, elsewhere] = nodesOf(state);
  const edgeId = Object.keys(state.draft.document.edges)[0]!;
  const reconnect = (toId: string): GraphCommand => ({
    commandSchemaVersion: 1,
    command: "RECONNECT_EDGE",
    expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId },
  });
  const applied = applyGraphCommand(state.draft, state.revision, reconnect(c!), ids(90));
  assert.deepEqual([applied.document.edges[edgeId]!.toId, applied.document.edges[edgeId]!.version], [c, 2]);
  assert.throws(() => applyGraphCommand(state.draft, state.revision, reconnect(elsewhere!), ids(90)), failsWith("INVALID_INPUT"));
});

test("ADD_EDGE with sides saves the layout entry; without sides it leaves no entry", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), addNode("C")]);
  const [a, b, c] = nodesOf(state);
  const flowId = flowOf(state);
  const withSides = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: state.revision,
    payload: { flowId, fromId: a!, toId: b!, condition: "", fromSide: "right", toSide: "left" },
  }, ids(90));
  const edgeId = withSides.createdIds[0]!;
  assert.equal(withSides.layoutChanged, true);
  assert.deepEqual(withSides.layout.edgeSides[edgeId], { from: "right", to: "left" });
  const without = applyGraphCommand(withSides, state.revision + 1, {
    commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: state.revision + 1,
    payload: { flowId, fromId: a!, toId: c!, condition: "" },
  }, ids(91));
  assert.equal(without.layoutChanged, false);
  assert.equal(Object.keys(without.layout.edgeSides).length, 1);
});

test("a side-only RECONNECT_EDGE changes the layout without touching the document, and is never refused as a no-op", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1)]);
  const [a, b] = nodesOf(state);
  const edgeId = Object.keys(state.draft.document.edges)[0]!;
  const flowId = flowOf(state);
  const edgeVersion = state.draft.document.edges[edgeId]!.version;
  const flowVersion = state.draft.document.flows[flowId]!.version;
  const sideOnly = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "bottom", toSide: "top" },
  }, ids(90));
  assert.equal(sideOnly.documentChanged, false);
  assert.equal(sideOnly.layoutChanged, true);
  assert.deepEqual(sideOnly.layout.edgeSides[edgeId], { from: "bottom", to: "top" });
  // The document (and its record versions) is exactly what it was: no revision or behaviour version moved.
  assert.equal(sideOnly.document.edges[edgeId]!.version, edgeVersion);
  assert.equal(sideOnly.document.flows[flowId]!.version, flowVersion);
  assert.deepEqual(sideOnly.versions, {});
  // Repeating the exact same sides is now a true no-op.
  const repeat = applyGraphCommand(sideOnly, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "bottom", toSide: "top", expectedSides: sideOnly.layout.edgeSides[edgeId] },
  }, ids(91));
  assert.equal(repeat.documentChanged, false);
  assert.equal(repeat.layoutChanged, false);
  // An endpoint change without sides clears any previously saved sides.
  const cleared = applyGraphCommand(sideOnly, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: b!, toId: a!, expectedSides: sideOnly.layout.edgeSides[edgeId] },
  }, ids(92));
  assert.equal(cleared.documentChanged, true);
  assert.equal(cleared.layoutChanged, true);
  assert.equal(cleared.layout.edgeSides[edgeId], undefined);
  // Changing endpoints while also giving new sides advances both: the layout change is not lost behind the document one.
  const movedWithSides = applyGraphCommand(sideOnly, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: b!, toId: a!, fromSide: "left", toSide: "right", expectedSides: sideOnly.layout.edgeSides[edgeId] },
  }, ids(93));
  assert.equal(movedWithSides.documentChanged, true);
  assert.equal(movedWithSides.layoutChanged, true);
  assert.deepEqual(movedWithSides.layout.edgeSides[edgeId], { from: "left", to: "right" });
});

test("deleting an edge or its nodes removes its saved connection-point entry", () => {
  const { state } = run([createFlow, addNode("A"), addNode("B"), connect(0, 1)]);
  const [a, b] = nodesOf(state);
  const edgeId = Object.keys(state.draft.document.edges)[0]!;
  const flowId = flowOf(state);
  const withSides = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "right", toSide: "left" },
  }, ids(90));
  const deletedEdge = applyGraphCommand(withSides, state.revision, {
    commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: state.revision, payload: { edgeId },
  }, ids(91));
  assert.deepEqual(deletedEdge.layout.edgeSides, {});
  assert.equal(deletedEdge.layoutChanged, true);

  const withSides2 = applyGraphCommand(state.draft, state.revision, {
    commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: state.revision,
    payload: { edgeId, fromId: a!, toId: b!, fromSide: "right", toSide: "left" },
  }, ids(92));
  const deletedNode = applyGraphCommand(withSides2, state.revision, {
    commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: state.revision,
    payload: { flowId, nodeIds: [a!], removeEdgeIds: [edgeId] },
  }, ids(93));
  assert.deepEqual(deletedNode.layout.edgeSides, {});
  assert.equal(deletedNode.layoutChanged, true);
});

test("text is stored exactly as typed: spacing, emoji, combining marks and right-to-left text survive", () => {
  const typed = "  Café ✅ שלום — e\u0301  ";
  const { state } = run([createFlow, addNode(typed)]);
  assert.equal(state.draft.document.nodes[nodesOf(state)[0]!]!.label, typed);
});
