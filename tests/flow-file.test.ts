import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseFlowFile, serializeFlowFile } from "../src/features/exchange/domain/flow-file.ts";

const fixture = (name: string) => readFile(new URL(`./fixtures/flow-files/${name}`, import.meta.url));
const valid = async () => parseFlowFile(await fixture("valid.scoperoom-flow.json"));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("round_trip_supported_fields", async () => {
  const parsed = await valid();
  assert.equal(parsed.nodes.length, 5);
  assert.equal(parsed.edges.at(-1)?.fromId, parsed.edges.at(-1)?.toId);
  assert.equal(parsed.nodes[2]?.actorLabel, null);
  assert.equal(parsed.edges[0]?.condition, null);
  assert.deepEqual(parseFlowFile(serializeFlowFile(parsed)), parsed);
});

test("rejects_authority_and_unknown_fields", async () => {
  const authority = await fixture("authority.scoperoom-flow.json");
  assert.throws(() => parseFlowFile(authority), /INVALID_INPUT/);
  const file = await valid();
  assert.throws(() => serializeFlowFile({ ...file, origin: { ...file.origin, approval: "APPROVED" } } as never), /INVALID_INPUT/);
});

test("rejects_invalid_bytes_depth_and_keys", () => {
  assert.throws(() => parseFlowFile(new Uint8Array(1_048_577)), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new Uint8Array([0xc3, 0x28])), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new TextEncoder().encode("[".repeat(21) + "0" + "]".repeat(21))), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new TextEncoder().encode('{"__proto__":"bad"}')), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new TextEncoder().encode('{"format":"scoperoom-flow","formatVersion":1,"exportedAt":"2026-10-01T00:00:00Z","producerVersion":"1.6","flow":{"title":"a\u0000","purpose":"","classification":"USER_JOURNEY","direction":"TB"},"nodes":[],"edges":[],"origin":{"kind":"DRAFT","documentRevision":1,"layoutRevision":1}}')), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new TextEncoder().encode('{"format":"scoperoom-flow","formatVersion":1,"exportedAt":"2026-10-01T00:00:00Z","producerVersion":"1.6","flow":{"title":"\\ud800","purpose":"","classification":"USER_JOURNEY","direction":"TB"},"nodes":[],"edges":[],"origin":{"kind":"DRAFT","documentRevision":1,"layoutRevision":1}}')), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(bytes({ format: "external-flow", formatVersion: 1 })), /INVALID_INPUT/);
});

test("requires_complete_geometry", async () => {
  const file = await valid();
  assert.throws(() => serializeFlowFile({ ...file, positions: file.positions?.slice(1) }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, positions: [...file.positions!, { nodeId: "extra", x: 0, y: 0 }] }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, edgeSides: [{ edgeId: "e1", from: "left" }] } as never), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, positions: [...file.positions!, file.positions![0]!] }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, positions: file.positions!.map((position, index) => index ? position : { ...position, x: Number.NaN }) }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, positions: file.positions!.map((position, index) => index ? position : { ...position, y: 100_001 }) }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, edgeSides: [{ edgeId: "e1", from: "left", to: "right" }, { edgeId: "e1", from: "left", to: "right" }] }), /INVALID_INPUT/);
});

test("accepts_incomplete_exploratory_graph", () => {
  const file = {
    format: "scoperoom-flow", formatVersion: 1, exportedAt: "2026-10-01T00:00:00Z", producerVersion: "1.6",
    flow: { title: "Idea", purpose: "", classification: "BUSINESS_PROCESS", direction: "TB" },
    nodes: [{ id: "n1", kind: "ACTION", label: `Investigate ${"[".repeat(20)} { braces } and "quotes"`, description: "", actorLabel: null, assumptionNotes: [] }],
    edges: [], origin: { kind: "DRAFT", documentRevision: 1, layoutRevision: 1 },
  };
  assert.deepEqual(parseFlowFile(bytes(file)), file);
});

test("rejects_duplicate_ids_dangling_edges_and_native_limits", async () => {
  const file = await valid();
  assert.throws(() => serializeFlowFile({ ...file, nodes: [...file.nodes, { ...file.nodes[0]! }] }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, edges: file.edges.map((edge, index) => index ? edge : { ...edge, toId: "missing" }) }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, flow: { ...file.flow, title: "x".repeat(121) } }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, nodes: Array.from({ length: 201 }, (_, index) => ({ ...file.nodes[0]!, id: `n${index}` })) }), /INVALID_INPUT/);
  assert.throws(() => serializeFlowFile({ ...file, edges: Array.from({ length: 401 }, (_, index) => ({ ...file.edges[0]!, id: `e${index}` })) }), /INVALID_INPUT/);
  const huge = structuredClone(file);
  huge.nodes = Array.from({ length: 200 }, (_, index) => ({ ...file.nodes[0]!, id: `n${index}`, description: "x".repeat(4_000), assumptionNotes: Array.from({ length: 20 }, () => "x".repeat(500)) }));
  huge.edges = [];
  delete huge.positions;
  delete huge.edgeSides;
  delete huge.linkHints;
  assert.throws(() => serializeFlowFile(huge), /INVALID_INPUT/);
});
