import assert from "node:assert/strict";
import test from "node:test";
import { parseArrangementRequest, parsePositionCommand, type MoveNodes } from "../src/features/drafts/contracts/positions.ts";
import { emptyDraft, type NodeRecord } from "../src/features/drafts/contracts/scope-document.ts";
import { GraphError, type Draft } from "../src/features/drafts/domain/graph.ts";
import { ALGORITHM_VERSION, applyArrangement, arrange, arrangementCanonical, moveNodes } from "../src/features/drafts/domain/layout.ts";

const flowId = "f0000000-0000-4000-8000-000000000000";
const otherFlow = "f1000000-0000-4000-8000-000000000000";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const failsWith = (code: string) => (error: unknown) => error instanceof GraphError && error.code === code;

/** A saved draft: steps 1..count in `flowId` stacked 160 px apart (position version 1), chained 1 → 2 → … . */
function saved(count: number, kinds: NodeRecord["kind"][] = []): Draft {
  const { document, layout } = emptyDraft();
  for (const flow of [flowId, otherFlow]) {
    document.flows[flow] = { id: flow, version: 1, behaviourVersion: 1, title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null };
    layout.directions[flow] = "TB";
  }
  for (let n = 1; n <= count; n += 1) {
    document.nodes[id(n)] = { id: id(n), flowId, version: 1, behaviourVersion: 1, kind: kinds[n - 1] ?? "ACTION", label: `Step ${n}`, description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
    layout.positions[id(n)] = { x: 0, y: (n - 1) * 160, version: 1 };
    if (n > 1) document.edges[id(100 + n)] = { id: id(100 + n), flowId, version: 1, fromId: id(n - 1), toId: id(n), condition: "", origin: "HUMAN", sourceRefs: [] };
  }
  document.nodes[id(99)] = { ...document.nodes[id(1)]!, id: id(99), flowId: otherFlow };
  layout.positions[id(99)] = { x: 0, y: 0, version: 1 };
  return { document, layout };
}
const move = (items: [node: number, version: number, x: number, y: number][]): MoveNodes =>
  ({ mode: "MOVE_NODES", flowId, items: items.map(([node, version, x, y]) => ({ nodeId: id(node), expectedPositionVersion: version, x, y })) });

test("position commands are strict: 1–20 distinct items, bounded coordinates, a real hash", () => {
  const item = (n: number) => ({ nodeId: id(n), expectedPositionVersion: 1, x: 10.5, y: -20 });
  assert.equal(parsePositionCommand({ mode: "MOVE_NODES", flowId, items: [item(1)] }).mode, "MOVE_NODES");
  for (const bad of [
    { mode: "MOVE_NODES", flowId, items: [] },
    { mode: "MOVE_NODES", flowId, items: Array.from({ length: 21 }, (_, n) => item(n + 1)) },
    { mode: "MOVE_NODES", flowId, items: [item(1), item(1)] },
    { mode: "MOVE_NODES", flowId, items: [{ ...item(1), x: 100_001 }] },
    { mode: "MOVE_NODES", flowId, items: [{ ...item(1), label: "no" }] },
    { mode: "ARRANGE_FLOW", flowId, expectedDocumentRevision: 1, expectedLayoutRevision: 1, direction: "TB", algorithmVersion: ALGORITHM_VERSION, arrangementHash: "abc" },
    { mode: "ARRANGE_FLOW", flowId, expectedDocumentRevision: 1, expectedLayoutRevision: 1, direction: "TB", algorithmVersion: ALGORITHM_VERSION, arrangementHash: "a".repeat(64), positions: {} },
  ]) assert.throws(() => parsePositionCommand(bad), /INVALID_INPUT/);
  assert.deepEqual(parseArrangementRequest({ flowId, expectedDocumentRevision: 2, expectedLayoutRevision: 3, direction: "LR" }), { flowId, expectedDocumentRevision: 2, expectedLayoutRevision: 3, direction: "LR" });
});

test("a move changes only touched positions and their versions; an unchanged item keeps its version", () => {
  const draft = saved(3);
  const placed = moveNodes(draft, move([[1, 1, 300, 40], [2, 1, 0, 160]]));
  assert.deepEqual(placed.positions, { [id(1)]: { x: 300, y: 40, version: 2 } });
  assert.deepEqual(placed.layout.positions[id(2)], { x: 0, y: 160, version: 1 });
  assert.equal(placed.layout.positions[id(3)], draft.layout.positions[id(3)]);
  assert.equal(moveNodes(draft, move([[1, 1, 0, 0]])).changed, false);
});

test("one stale item refuses the whole group; a deleted node refuses a late move; another flow's node is forged input", () => {
  const draft = saved(3);
  assert.throws(() => moveNodes(draft, move([[1, 1, 5, 5], [2, 7, 5, 5]])),
    (error: unknown) => failsWith("POSITION_CONFLICT")(error) && (error as GraphError).details?.nodeId === id(2) && (error as GraphError).details?.currentVersion === 1);
  assert.throws(() => moveNodes(draft, move([[42, 1, 5, 5]])), (error: unknown) => failsWith("POSITION_CONFLICT")(error) && (error as GraphError).details?.currentVersion === null);
  assert.throws(() => moveNodes(draft, move([[99, 1, 5, 5]])), failsWith("INVALID_INPUT"));
});

test("arrangement is deterministic, uses fixed sizes, and ignores stored key order", () => {
  const draft = saved(4, ["START", "ACTION", "DECISION", "OUTCOME"]);
  const first = arrange(draft.document, flowId, "TB");
  const reversed = { ...draft.document, nodes: Object.fromEntries(Object.entries(draft.document.nodes).reverse()), edges: Object.fromEntries(Object.entries(draft.document.edges).reverse()) };
  assert.deepEqual(arrange(reversed, flowId, "TB"), first);
  assert.deepEqual(Object.keys(first).sort(), [id(1), id(2), id(3), id(4)]);
  assert(Object.values(first).every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0));
  const ys = [1, 2, 3, 4].map((n) => first[id(n)]!.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, "a chain runs top to bottom");
  const across = arrange(draft.document, flowId, "LR");
  const xs = [1, 2, 3, 4].map((n) => across[id(n)]!.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "and left to right in LR");
});

test("the arrangement hash covers the exact saved pair, direction and positions", () => {
  const draft = saved(3);
  const positions = arrange(draft.document, flowId, "TB");
  const context = { projectId: id(500), draftId: id(501), flowId, documentRevision: 4, layoutRevision: 4, direction: "TB" as const };
  const canonical = arrangementCanonical(context, positions);
  assert.equal(arrangementCanonical(context, Object.fromEntries(Object.entries(positions).reverse())), canonical);
  assert.notEqual(arrangementCanonical({ ...context, layoutRevision: 5 }, positions), canonical);
  assert.notEqual(arrangementCanonical({ ...context, direction: "LR" }, positions), canonical);
  assert.match(canonical, new RegExp(ALGORITHM_VERSION));
});

test("applying an arrangement versions only moved nodes; a direction change alone still saves; the same result twice is a no-op", () => {
  const draft = saved(3);
  const positions = arrange(draft.document, flowId, "TB");
  const placed = applyArrangement(draft, flowId, "TB", positions);
  assert.equal(placed.changed, true);
  assert(Object.values(placed.positions).every((position) => position.version === 2));
  const settled = { document: draft.document, layout: placed.layout };
  assert.equal(applyArrangement(settled, flowId, "TB", positions).changed, false);
  const turned = applyArrangement(settled, flowId, "LR", positions);
  assert.deepEqual([turned.changed, Object.keys(turned.positions).length, turned.layout.directions[flowId]], [true, 0, "LR"]);
  assert.equal(placed.layout.positions[id(99)], draft.layout.positions[id(99)], "other flows keep their positions");
});

test("arrangement handles cycles, self-loops and unconnected steps without dropping any step", () => {
  const draft = saved(3);
  const edge = (n: number, fromId: string, toId: string) => ({ id: id(n), flowId, version: 1, fromId, toId, condition: "", origin: "HUMAN" as const, sourceRefs: [] as [] });
  draft.document.edges[id(200)] = edge(200, id(3), id(1)); // back to the start: a cycle
  draft.document.edges[id(201)] = edge(201, id(2), id(2)); // a self-loop
  draft.document.nodes[id(4)] = { ...draft.document.nodes[id(1)]!, id: id(4), label: "Alone" };
  draft.layout.positions[id(4)] = { x: 900, y: 900, version: 1 };
  const positions = arrange(draft.document, flowId, "TB");
  assert.deepEqual(Object.keys(positions).sort(), [id(1), id(2), id(3), id(4)]);
  assert(Object.values(positions).every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y)));
  assert.equal(applyArrangement(draft, flowId, "TB", positions).changed, true);
});
