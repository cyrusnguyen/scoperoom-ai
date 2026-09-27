import assert from "node:assert/strict";
import test from "node:test";
import { emptyDraft, LIMITS, parseDocument, parseDraftPair } from "../src/features/drafts/contracts/scope-document.ts";
import { id, utf8Bytes } from "../src/features/drafts/contracts/strict.ts";

type Json = Record<string, unknown>;
type Stored = { document: Json; layout: Json };

const flowId = "00000000-0000-4000-8000-000000000001";
const startId = "00000000-0000-4000-8000-000000000002";
const endId = "00000000-0000-4000-8000-000000000003";
const edgeId = "00000000-0000-4000-8000-000000000004";
const unknownId = "00000000-0000-4000-8000-0000000000ff";

/** One flow, START → OUTCOME, both positioned. The JSON round trip gives the stored (plain-object) form. */
function stored(): Stored {
  const node = (id: string, kind: string, label: string) => ({ id, flowId, version: 1, behaviourVersion: 1, kind, label, description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] });
  const { document, layout } = emptyDraft();
  return JSON.parse(JSON.stringify({
    document: {
      ...document,
      flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null } },
      nodes: { [startId]: node(startId, "START", "Cart"), [endId]: node(endId, "OUTCOME", "Paid") },
      edges: { [edgeId]: { id: edgeId, flowId, version: 1, fromId: startId, toId: endId, condition: "", origin: "HUMAN", sourceRefs: [] } },
    },
    layout: { ...layout, positions: { [startId]: { x: 0, y: 0, version: 1 }, [endId]: { x: 0, y: 160, version: 1 } }, directions: { [flowId]: "TB" } },
  })) as Stored;
}

/** The nested object at `path`, so a test can change one stored field. */
const at = (root: Json, ...path: string[]) => path.reduce((node, key) => node[key] as Json, root);

function rejects(change: (draft: Stored) => void) {
  const draft = stored();
  change(draft);
  assert.throws(() => parseDraftPair(draft.document, draft.layout), /INVALID_INPUT/);
}

test("the empty draft and a small valid flow both parse", () => {
  const empty = emptyDraft();
  assert.deepEqual(parseDraftPair(JSON.parse(JSON.stringify(empty.document)), JSON.parse(JSON.stringify(empty.layout))), empty);
  const { document, layout } = stored();
  const parsed = parseDraftPair(document, layout);
  assert.equal(parsed.document.nodes[startId]!.label, "Cart");
  assert.deepEqual(parsed.layout.positions[endId], { x: 0, y: 160, version: 1 });
});

test("a DATA_STORE node parses like any other kind, and an unknown kind is rejected", () => {
  const draft = stored();
  at(draft.document, "nodes", startId).kind = "DATA_STORE";
  assert.equal(parseDraftPair(draft.document, draft.layout).document.nodes[startId]!.kind, "DATA_STORE");
  rejects((bad) => { at(bad.document, "nodes", startId).kind = "TABLE"; });
});

test("unknown or missing properties, and unsupported schema versions, are rejected", () => {
  rejects((draft) => { draft.document.extra = true; });
  rejects((draft) => { delete at(draft.document, "nodes", startId).actorLabel; });
  rejects((draft) => { at(draft.document, "nodes", startId).x = 1; });
  rejects((draft) => { draft.document.schemaVersion = 2; });
  rejects((draft) => { draft.layout.schemaVersion = 2; });
});

test("references stay inside one flow, and ids are unique across collections", () => {
  rejects((draft) => { at(draft.document, "edges", edgeId).toId = unknownId; });
  rejects((draft) => { at(draft.document, "nodes", startId).flowId = unknownId; });
  rejects((draft) => { at(draft.document, "nodes")[flowId] = { ...at(draft.document, "nodes", startId), id: flowId }; });
  rejects((draft) => { at(draft.document, "nodes")["not-the-id"] = at(draft.document, "nodes", startId); });
});

test("every node has exactly one position and every flow one direction", () => {
  rejects((draft) => { delete at(draft.layout, "positions")[endId]; });
  rejects((draft) => { at(draft.layout, "positions")[unknownId] = { x: 0, y: 0, version: 1 }; });
  rejects((draft) => { delete at(draft.layout, "directions")[flowId]; });
  rejects((draft) => { at(draft.layout, "directions")[flowId] = "RL"; });
});

test("coordinates, versions and text respect their bounds", () => {
  rejects((draft) => { at(draft.layout, "positions", startId).x = 100_001; });
  rejects((draft) => { at(draft.layout, "positions", startId).y = Number.NaN; });
  rejects((draft) => { at(draft.document, "nodes", startId).version = 0; });
  rejects((draft) => { at(draft.document, "nodes", startId).version = 2_147_483_648; });
  rejects((draft) => { at(draft.document, "nodes", startId).label = "x".repeat(161); });
  rejects((draft) => { at(draft.document, "nodes", startId).label = "   "; });
  rejects((draft) => { at(draft.document, "nodes", startId).label = "broken \ud800 surrogate"; });
  const long = stored();
  at(long.document, "nodes", startId).label = "é".repeat(160); // 160 code points, 320 UTF-8 bytes
  assert.equal(parseDraftPair(long.document, long.layout).document.nodes[startId]!.label.length, 160);
});

test("collections owned by later stages stay empty, and retired ids stay sorted and inactive", () => {
  rejects((draft) => { at(draft.document, "requirements")[flowId] = {}; });
  rejects((draft) => { at(draft.document, "flows", flowId).confirmation = { behaviourVersion: 1 }; });
  rejects((draft) => { at(draft.document, "nodes", startId).sourceRefs = [{}]; });
  rejects((draft) => { draft.document.retiredEntityIds = [startId]; });
  rejects((draft) => { draft.document.retiredEntityIds = [unknownId, "00000000-0000-4000-8000-0000000000fe"]; });
  const retired = stored();
  retired.document.retiredEntityIds = ["00000000-0000-4000-8000-0000000000fe", unknownId];
  assert.equal(parseDraftPair(retired.document, retired.layout).document.retiredEntityIds.length, 2);
});

test("a JSON __proto__ key is an ordinary rejected key, never a prototype change", () => {
  const draft = stored();
  const document = JSON.parse(JSON.stringify(draft.document).replace('"nodes":{', '"nodes":{"__proto__":{"id":"x"},')) as Json;
  assert.throws(() => parseDraftPair(document, draft.layout), /INVALID_INPUT/);
});

test("an otherwise valid document above the byte cap is rejected before persistence", () => {
  const { document, layout } = stored();
  assert.doesNotThrow(() => parseDraftPair(document, layout));
  const retiredCount = 60_000;
  document.retiredEntityIds = Array.from({ length: retiredCount }, (_, index) =>
    `00000000-0000-4000-8000-${(index + 10_000).toString(16).padStart(12, "0")}`,
  );
  assert.ok(utf8Bytes(document) > LIMITS.documentBytes);
  assert.equal(parseDocument(document).retiredEntityIds.length, retiredCount);
  assert.throws(() => parseDraftPair(document, layout), /INVALID_INPUT/);
});

test("ids must use lowercase UUID hex", () => {
  assert.throws(() => id(unknownId.toUpperCase()), /INVALID_INPUT/);
});
