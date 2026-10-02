import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FlowFileV1 } from "../src/features/exchange/contracts/flow-file.ts";
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
  assert.equal(parsed.nodes[1]?.description, "Supports Unicode: café");
  assert.deepEqual(parsed.nodes.map(node => node.kind), ["START", "ACTION", "DECISION", "DATA_STORE", "OUTCOME"]);
  assert.equal(parsed.flow.direction, "LR");
  assert.deepEqual(parsed.edgeSides?.[0], { edgeId: "e1", from: "right", to: "left" });
  assert.deepEqual(parsed.linkHints, [{ nodeId: "n-action", requirementId: "REQ-1", requirementTitle: "Select a plan" }]);
  assert.equal(parsed.origin.kind, "SNAPSHOT");
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
  assert.throws(() => parseFlowFile(bytes({ ...file, positions: file.positions!.map((position, index) => index ? position : { nodeId: position.nodeId, x: position.x }) })), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(bytes({ ...file, positions: file.positions!.map((position, index) => index ? position : { ...position, z: 0 }) })), /INVALID_INPUT/);
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

test("rejects_impossible_export_timestamps", async () => {
  const file = await valid();
  for (const exportedAt of ["2026-02-30T00:00:00Z", "2025-02-29T12:00:00Z", "2026-04-31T23:59:59Z", "2026-10-01T24:00:00Z"]) {
    assert.throws(() => parseFlowFile(bytes({ ...file, exportedAt })), /INVALID_INPUT/, exportedAt);
    assert.throws(() => serializeFlowFile({ ...file, exportedAt }), /INVALID_INPUT/, exportedAt);
  }
  for (const exportedAt of ["2024-02-29T12:00:00Z", "2026-10-01T12:34:56.1Z", "2026-10-01T12:34:56.12Z", "2026-10-01T12:34:56.123Z"]) {
    assert.equal(parseFlowFile(bytes({ ...file, exportedAt })).exportedAt, exportedAt);
  }
});

test("serializer_rejects_sparse_arrays_instead_of_emitting_invalid_native_files", async () => {
  const file = await valid();
  for (const field of ["positions", "nodes", "edges", "edgeSides", "linkHints"] as const) {
    const sparse = structuredClone(file);
    delete sparse[field]![0];
    assert.throws(() => serializeFlowFile(sparse), /INVALID_INPUT/, field);
  }
  const sparseNotes = structuredClone(file);
  sparseNotes.nodes[0]!.assumptionNotes = new Array<string>(1);
  assert.throws(() => serializeFlowFile(sparseNotes), /INVALID_INPUT/);
});

test("unsupported_formats_preserve_a_bounded_service_mapping_cause", async () => {
  const file = await valid();
  for (const value of [{ format: "external-flow" }, { format: "scoperoom-flow", formatVersion: 2 }, { ...file, formatVersion: 2 }]) {
    assert.throws(() => parseFlowFile(bytes(value)), { message: "INVALID_INPUT", cause: "UNSUPPORTED_FLOW_FORMAT" });
  }
  for (const value of [{}, { format: 42 }, { format: "scoperoom-flow" }, { ...file, formatVersion: "2" }, { ...file, formatVersion: 0 }]) {
    assert.throws(() => parseFlowFile(bytes(value)), error => error instanceof Error && error.message === "INVALID_INPUT" && error.cause === undefined);
  }
  for (const input of [
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode('{"format":"external-flow","x":' + "[".repeat(20) + "0" + "]".repeat(20) + "}"),
    new TextEncoder().encode('{"format":"external-flow","constructor":{}}'),
    new TextEncoder().encode('{"format":"external-flow",'),
  ]) {
    assert.throws(() => parseFlowFile(input), error => error instanceof Error && error.message === "INVALID_INPUT" && error.cause === undefined);
  }
});

test("byte_and_nesting_limits_apply_before_json_parsing", async context => {
  const file = await valid();
  const encoded = bytes(file);
  const exact = new Uint8Array(1_048_576).fill(0x20);
  exact.set(encoded);
  assert.deepEqual(parseFlowFile(exact), file);
  const jsonParse = context.mock.method(JSON, "parse");
  assert.throws(() => parseFlowFile(new Uint8Array(1_048_577)), /INVALID_INPUT/);
  assert.equal(jsonParse.mock.callCount(), 0);
  assert.throws(() => parseFlowFile(new TextEncoder().encode("[".repeat(21) + "0" + "]".repeat(21))), /INVALID_INPUT/);
  assert.equal(jsonParse.mock.callCount(), 0);
  assert.throws(() => parseFlowFile(new TextEncoder().encode("[".repeat(20) + "0" + "]".repeat(20))), /INVALID_INPUT/);
  assert.equal(jsonParse.mock.callCount(), 1); // Depth 20 reaches schema validation; 21 must not reach JSON.parse.
});

test("native_text_limits_count_unicode_code_points_and_reject_one_over", async () => {
  const file = await valid();
  const fields: [string, number, (file: FlowFileV1, value: string) => void][] = [
    ["producerVersion", 120, (file, value) => { file.producerVersion = value; }],
    ["title", 120, (file, value) => { file.flow.title = value; }],
    ["purpose", 4_000, (file, value) => { file.flow.purpose = value; }],
    ["label", 160, (file, value) => { file.nodes[0]!.label = value; }],
    ["description", 4_000, (file, value) => { file.nodes[0]!.description = value; }],
    ["actorLabel", 100, (file, value) => { file.nodes[0]!.actorLabel = value; }],
    ["note", 500, (file, value) => { file.nodes[0]!.assumptionNotes = [value]; }],
    ["condition", 240, (file, value) => { file.edges[0]!.condition = value; }],
    ["requirementId", 120, (file, value) => { file.linkHints![0]!.requirementId = value; }],
    ["requirementTitle", 120, (file, value) => { file.linkHints![0]!.requirementTitle = value; }],
  ];
  for (const [name, limit, set] of fields) {
    const bounded = structuredClone(file);
    set(bounded, "🌱".repeat(limit));
    assert.deepEqual(parseFlowFile(serializeFlowFile(bounded)), bounded, name);
    set(bounded, "🌱".repeat(limit + 1));
    assert.throws(() => parseFlowFile(bytes(bounded)), /INVALID_INPUT/, name);
    assert.throws(() => serializeFlowFile(bounded), /INVALID_INPUT/, name);
    for (const invalidText of ["embedded\u0000NUL", "lone\ud800surrogate"]) {
      set(bounded, invalidText);
      assert.throws(() => parseFlowFile(bytes(bounded)), /INVALID_INPUT/, name);
    }
  }
  const notes = structuredClone(file);
  notes.nodes[0]!.assumptionNotes = Array.from({ length: 20 }, () => "A note");
  assert.deepEqual(parseFlowFile(serializeFlowFile(notes)), notes);
  notes.nodes[0]!.assumptionNotes.push("One over");
  assert.throws(() => parseFlowFile(bytes(notes)), /INVALID_INPUT/);
});

test("accepts_exact_counts_and_rejects_global_id_collisions_and_dangerous_ids", async () => {
  const file = await valid();
  delete file.positions;
  delete file.edgeSides;
  delete file.linkHints;
  file.nodes = Array.from({ length: 200 }, (_, index) => ({ ...file.nodes[0]!, id: `n${index}` }));
  file.edges = Array.from({ length: 400 }, (_, index) => ({ id: `e${index}`, fromId: "n0", toId: "n0", condition: null }));
  assert.deepEqual(parseFlowFile(serializeFlowFile(file)), file);
  file.edges[0]!.id = "n0";
  assert.throws(() => parseFlowFile(bytes(file)), /INVALID_INPUT/);
  file.edges = [];
  file.nodes = [file.nodes[0]!];
  file.nodes[0]!.id = "n".repeat(64);
  assert.deepEqual(parseFlowFile(serializeFlowFile(file)), file);
  for (const id of ["n".repeat(65), "", "__proto__", "prototype", "constructor", "has space", "café"]) {
    file.nodes[0]!.id = id;
    assert.throws(() => parseFlowFile(bytes(file)), /INVALID_INPUT/, id);
  }
});

test("optional_geometry_hints_and_provenance_remain_closed_and_bounded", async () => {
  const file = await valid();
  const viewport = { x: -100_000, y: 100_000, zoom: 100 };
  assert.deepEqual(parseFlowFile(bytes({ ...file, viewport })).viewport, viewport);
  for (const zoom of [0, -1, 101, 1e309]) {
    assert.throws(() => serializeFlowFile({ ...file, viewport: { ...viewport, zoom } }), /INVALID_INPUT/);
  }
  assert.throws(() => parseFlowFile(new TextEncoder().encode(JSON.stringify(file).replace('"x":0', '"x":1e309'))), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(bytes({ ...file, edgeSides: [{ edgeId: "missing", from: "top", to: "bottom" }] })), /INVALID_INPUT/);
  assert.throws(() => parseFlowFile(bytes({ ...file, linkHints: [{ ...file.linkHints![0]!, nodeId: "missing" }] })), /INVALID_INPUT/);
  assert.equal(parseFlowFile(bytes({ ...file, linkHints: Array.from({ length: 400 }, () => file.linkHints![0]!) })).linkHints?.length, 400);
  assert.throws(() => parseFlowFile(bytes({ ...file, linkHints: Array.from({ length: 401 }, () => file.linkHints![0]!) })), /INVALID_INPUT/);
  for (const origin of [
    { ...file.origin, contentHash: "x".repeat(64) }, { ...file.origin, snapshotId: "n1" },
    { ...file.origin, sourceInclusion: "APPROVED" }, { ...file.origin, documentRevision: 0 },
    { ...file.origin, layoutRevision: 2_147_483_648 },
  ]) assert.throws(() => parseFlowFile(bytes({ ...file, origin })), /INVALID_INPUT/);
  for (const key of ["__proto__", "prototype", "constructor"]) {
    assert.throws(() => parseFlowFile(new TextEncoder().encode(JSON.stringify(file).replace('"purpose":', `"${key}":`))), /INVALID_INPUT/, key);
  }
  const absent = structuredClone(file);
  delete absent.positions;
  delete absent.edgeSides;
  delete absent.viewport;
  delete absent.linkHints;
  assert.deepEqual(parseFlowFile(serializeFlowFile(absent)), absent);
});
