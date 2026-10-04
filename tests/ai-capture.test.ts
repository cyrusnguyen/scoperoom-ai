import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyDraft, type ScopeDocument } from "../src/features/drafts/contracts/scope-document.ts";
import { canonicalJson, captureInput, evidenceStats, jsonbTextBytes, normalizeEvidence, type SavedContext, type SavedSource } from "../src/features/proposals/domain/capture.ts";
import { lineStarts } from "../src/features/sources/contracts/source-version.ts";
import { AI_LIMITS, TASK_EDITS, parseStartRunInput, type StartRunInput } from "../src/features/proposals/contracts/tasks.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const KEY = "k".repeat(24);
const rejects = (run: () => unknown, message: string) => assert.throws(run, (error) => error instanceof Error && error.message === message);

test("normalizeEvidence preserves text except BOM and line endings", () => {
  assert.equal(normalizeEvidence("\uFEFFa\r\nb\rc"), "a\nb\nc");
  assert.equal(Array.from(normalizeEvidence("😀")).length, 1);
});

test("evidenceStats measures bytes and hash on the normalized text only", () => {
  const stats = evidenceStats("\uFEFFé\r\n😀");
  assert.deepEqual(stats, { text: "é\n😀", codePointCount: 3, utf8ByteCount: 7, contentHash: sha("é\n😀") });
});

function build() {
  const projectId = randomUUID(), draftId = randomUUID(), flowId = randomUUID(), otherFlowId = randomUUID();
  const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), stray: randomUUID(), foreign: randomUUID() };
  const { document } = emptyDraft();
  const flow = (id: string, title: string) => ({ id, version: 2, behaviourVersion: 1, title, purpose: "p", classification: "USER_JOURNEY" as const, inclusion: "UNDECIDED" as const, confirmation: null, verificationMethod: null });
  const node = (id: string, flow: string, label: string) => ({ id, flowId: flow, version: 3, behaviourVersion: 1, kind: "ACTION" as const, label, description: "", actorLabel: "", origin: "HUMAN" as const, sourceRefs: [] as [], assumptionNotes: [] });
  const edge = (id: string, from: string, to: string) => ({ id, flowId, version: 4, fromId: from, toId: to, condition: "", origin: "HUMAN" as const, sourceRefs: [] as [] });
  document.flows = { [flowId]: flow(flowId, "Main"), [otherFlowId]: flow(otherFlowId, "Other") };
  document.nodes = { [ids.a]: node(ids.a, flowId, "A"), [ids.b]: node(ids.b, flowId, "B"), [ids.c]: node(ids.c, flowId, "C"), [ids.d]: node(ids.d, flowId, "D"), [ids.stray]: node(ids.stray, otherFlowId, "S") };
  const e1 = randomUUID(), e2 = randomUUID(), e3 = randomUUID();
  document.edges = { [e1]: edge(e1, ids.a, ids.b), [e2]: edge(e2, ids.b, ids.c), [e3]: edge(e3, ids.c, ids.d) };
  const text = "line one\nline two";
  const source: SavedSource = { projectId, sourceId: randomUUID(), sourceVersionId: randomUUID(), currentVersionId: "", title: "Notes", text, contentHash: sha(text) };
  source.currentVersionId = source.sourceVersionId;
  const saved: SavedContext = { projectId, draftId, documentRevision: 7, parentSnapshotId: null, document, sources: [], model: "model-x" };
  const improve = (nodeIds: string[], over: Record<string, unknown> = {}): StartRunInput => parseStartRunInput({
    taskType: "REFINE_FLOW_SELECTION", prompt: "tighten", draftId, expectedDocumentRevision: 7, expectedParentSnapshotId: null,
    context: { selection: { flowId, nodeIds }, sources: [] }, ...over,
  }, KEY);
  const generate = (over: Record<string, unknown> = {}): StartRunInput => parseStartRunInput({
    taskType: "PROPOSE_FLOW", prompt: "make a flow", draftId, expectedDocumentRevision: 7, expectedParentSnapshotId: null,
    context: { selection: null, sources: [] }, ...over,
  }, KEY);
  return { saved, ids, flowId, otherFlowId, source, improve, generate, draftId, projectId, document, edges: { e1, e2, e3 } };
}

test("prompt bound counts normalized code points: 8,000 pass and 8,001 reject", () => {
  const { saved, generate } = build();
  const capture = (prompt: string) => captureInput(saved, generate({ prompt })).capture;
  assert.equal(AI_LIMITS.promptCodePoints, 8_000);
  assert.equal(capture("x".repeat(8_000)).prompt.length, 8_000);
  assert.equal(Array.from(capture("😀".repeat(8_000)).prompt).length, 8_000);
  assert.equal(capture("x".repeat(7_999) + "\r\n").prompt, "x".repeat(7_999) + "\n", "CRLF normalizes to one code point");
  assert.equal(capture("\uFEFFhello").prompt, "hello");
  rejects(() => capture("x".repeat(8_001)), "INVALID_INPUT");
  rejects(() => capture("😀".repeat(8_001)), "INVALID_INPUT");
  rejects(() => generate({ prompt: "   \n " }), "INVALID_INPUT");
  rejects(() => generate({ prompt: "bad \ud800" }), "INVALID_INPUT");
});

test("the strict body rejects unknown tasks, extra keys and malformed context", () => {
  const { generate, improve, ids, draftId } = build();
  rejects(() => generate({ taskType: "ASK" }), "INVALID_INPUT");
  rejects(() => generate({ taskType: "SUMMARIZE_REQUIREMENTS" }), "INVALID_INPUT");
  rejects(() => generate({ conversationId: randomUUID() }), "INVALID_INPUT");
  rejects(() => generate({ context: { selection: null, sources: [], previousRunId: randomUUID() } }), "INVALID_INPUT");
  rejects(() => generate({ draftId: "not-a-uuid" }), "INVALID_INPUT");
  rejects(() => generate({ expectedDocumentRevision: 0 }), "INVALID_INPUT");
  rejects(() => generate({ expectedParentSnapshotId: "x" }), "INVALID_INPUT");
  rejects(() => generate({ context: { selection: { flowId: randomUUID(), nodeIds: [ids.a] }, sources: [] } }), "INVALID_INPUT"); // Generate takes no selection
  rejects(() => improve([]), "INVALID_INPUT");
  rejects(() => improve([ids.a, ids.a]), "INVALID_INPUT");
  rejects(() => parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "x", draftId, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, "short"), "INVALID_INPUT");
  const dup = { sourceVersionId: randomUUID(), expectedCurrentVersionId: randomUUID() };
  rejects(() => generate({ context: { selection: null, sources: [dup, dup] } }), "INVALID_INPUT");
});

test("a Generate capture of an empty project holds an empty graph", () => {
  const { saved, generate } = build();
  const empty = { ...saved, document: emptyDraft().document };
  const { capture } = captureInput(empty, generate());
  assert.deepEqual(capture.graph, { flows: [], nodes: [], edges: [], boundaryNodeIds: [] });
  assert.equal(capture.selection, null);
  assert.equal(capture.taskType, "PROPOSE_FLOW");
});

test("Generate refuses a document that has no room for a new flow", () => {
  const { saved, generate } = build();
  const full: ScopeDocument = structuredClone(saved.document);
  const template = Object.values(full.flows)[0]!;
  while (Object.keys(full.flows).length < 5) { const id = randomUUID(); full.flows[id] = { ...template, id }; }
  rejects(() => captureInput({ ...saved, document: full }, generate()), "LIMIT_EXCEEDED");
});

test("Improve captures the selection, its incident edges and read-only boundary neighbours only", () => {
  const { saved, ids, improve, flowId, edges } = build();
  const { capture } = captureInput(saved, improve([ids.b, ids.c]));
  assert.deepEqual(capture.selection, { flowId, nodeIds: [ids.b, ids.c].sort() });
  assert.deepEqual(capture.graph.nodes.map((n) => n.id).sort(), [ids.a, ids.b, ids.c, ids.d].sort());
  assert.deepEqual(capture.graph.boundaryNodeIds, [ids.a, ids.d].sort());
  assert.deepEqual(capture.graph.edges.map((e) => e.id).sort(), [edges.e1, edges.e2, edges.e3].sort());
  assert.deepEqual(capture.graph.flows.map((f) => f.id), [flowId]);
  const only = captureInput(saved, improve([ids.a])).capture;
  assert.deepEqual(only.graph.nodes.map((n) => n.id).sort(), [ids.a, ids.b].sort(), "unselected C, D and the other flow stay out");
  assert.ok(!only.graph.nodes.some((n) => n.id === ids.stray));
  assert.deepEqual(only.graph.edges.map((e) => e.id), [edges.e1]);
  const boundary = only.graph.nodes.find((n) => n.id === ids.b)!;
  assert.equal(boundary.readOnly, true);
  assert.equal(only.graph.nodes.find((n) => n.id === ids.a)!.readOnly, false);
  assert.equal(boundary.version, 3, "exact saved record versions are captured");
});

test("foreign, cross-flow and stale references reject", () => {
  const { saved, ids, improve, generate, source, flowId, otherFlowId, projectId } = build();
  rejects(() => captureInput(saved, improve([ids.foreign])), "INVALID_INPUT");
  rejects(() => captureInput(saved, improve([ids.a, ids.stray])), "INVALID_INPUT");
  rejects(() => captureInput(saved, improve([ids.stray])), "INVALID_INPUT"); // right id, wrong flow
  rejects(() => captureInput(saved, improve([ids.a], { context: { selection: { flowId: randomUUID(), nodeIds: [ids.a] }, sources: [] } })), "INVALID_INPUT");
  rejects(() => captureInput(saved, improve([ids.a], { draftId: randomUUID() })), "DRAFT_REPLACED");
  rejects(() => captureInput(saved, improve([ids.a], { expectedDocumentRevision: 6 })), "STALE_DOCUMENT_REVISION");
  rejects(() => captureInput(saved, generate({ expectedParentSnapshotId: randomUUID() })), "BASELINE_CHANGED");
  const ref = { sourceVersionId: source.sourceVersionId, expectedCurrentVersionId: source.currentVersionId };
  rejects(() => captureInput(saved, generate({ context: { selection: null, sources: [ref] } })), "INVALID_SOURCE_REFERENCE"); // never loaded: not explicitly selected
  rejects(() => captureInput({ ...saved, sources: [{ ...source, projectId: randomUUID() }] }, generate({ context: { selection: null, sources: [ref] } })), "INVALID_SOURCE_REFERENCE");
  rejects(() => captureInput({ ...saved, sources: [source] }, generate()), "INVALID_SOURCE_REFERENCE"); // loaded but not selected
  void flowId; void otherFlowId; void projectId;
});

test("source heads, hashes and text are captured exactly and a changed head rejects", () => {
  const { saved, source, generate } = build();
  const ref = { sourceVersionId: source.sourceVersionId, expectedCurrentVersionId: source.currentVersionId };
  const input = generate({ context: { selection: null, sources: [ref] } });
  const { capture } = captureInput({ ...saved, sources: [source] }, input);
  assert.deepEqual(capture.sources, [{
    sourceVersionId: source.sourceVersionId, sourceId: source.sourceId, title: "Notes", text: source.text, contentHash: sha(source.text),
    codePointCount: 17, utf8ByteCount: 17, expectedCurrentVersionId: source.currentVersionId,
  }]);
  const moved = { ...source, currentVersionId: randomUUID() };
  rejects(() => captureInput({ ...saved, sources: [moved] }, input), "CONFLICT");
  rejects(() => captureInput({ ...saved, sources: [{ ...source, contentHash: sha("other") }] }, input), "INVALID_SOURCE_REFERENCE");
  const historical = { ...source, currentVersionId: randomUUID() };
  const explicitHistory = generate({ context: { selection: null, sources: [{ ...ref, expectedCurrentVersionId: historical.currentVersionId }] } });
  assert.equal(captureInput({ ...saved, sources: [historical] }, explicitHistory).capture.sources[0]!.sourceVersionId, source.sourceVersionId, "an older exact version is allowed when its head expectation holds");
});

test("the capture is an exact, deterministic value snapshot", () => {
  const { saved, ids, improve } = build();
  const first = captureInput(saved, improve([ids.b, ids.a]));
  const second = captureInput(saved, improve([ids.a, ids.b]));
  assert.equal(first.serialized, second.serialized, "selection order does not change the capture");
  assert.equal(first.hash, sha(first.serialized));
  assert.deepEqual(JSON.parse(first.serialized), first.capture);
  saved.document.nodes[ids.a]!.label = "changed after capture";
  saved.document.nodes[ids.b]!.version = 99;
  assert.equal(first.capture.graph.nodes.find((n) => n.id === ids.a)!.label, "A", "later saved edits cannot alter a captured value");
  assert.notEqual(captureInput(saved, improve([ids.a, ids.b])).hash, first.hash, "recapturing live content is a different capture");
  assert.notEqual(captureInput(saved, improve([ids.a])).hash, second.hash);
  assert.equal(first.capture.documentRevision, 7);
  assert.equal(first.capture.versions.model, "model-x");
  assert.equal(first.capture.limits.maxInputTokens, 16_000);
});

test("a capture beyond its byte ceiling rejects instead of truncating", () => {
  const { saved, ids, improve, flowId } = build();
  const big = structuredClone(saved);
  for (let i = 0; i < 100; i += 1) { const id = randomUUID(); big.document.nodes[id] = { ...big.document.nodes[ids.a]!, id, description: "😀".repeat(4_000) }; }
  const selection = Object.keys(big.document.nodes).filter((id) => big.document.nodes[id]!.flowId === flowId);
  rejects(() => captureInput(big, improve(selection)), "LIMIT_EXCEEDED");
});

test("task edit vocabulary: Generate creates a new flow, Improve never edits whole flows", () => {
  assert.deepEqual([...TASK_EDITS.PROPOSE_FLOW], ["CREATE_FLOW", "ADD_NODE", "ADD_EDGE"]);
  assert.ok(!TASK_EDITS.REFINE_FLOW_SELECTION.includes("CREATE_FLOW" as never));
  assert.ok(TASK_EDITS.REFINE_FLOW_SELECTION.includes("DELETE_NODES"));
  assert.deepEqual({ ops: AI_LIMITS.operations, deps: AI_LIMITS.dependsOn, notes: AI_LIMITS.assumptions, noteCp: AI_LIMITS.assumptionCodePoints, cites: AI_LIMITS.citations, excerptCp: AI_LIMITS.excerptCodePoints },
    { ops: 100, deps: 100, notes: 20, noteCp: 2_000, cites: 100, excerptCp: 2_000 });
  assert.deepEqual({ capture: AI_LIMITS.captureBytes, result: AI_LIMITS.resultBytes }, { capture: 256 * 1024, result: 128 * 1024 });
});

test("canonicalJson sorts keys recursively, is compact and ignores insertion order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: null, y: "x" }], c: undefined } }), '{"a":{"d":[1,{"y":"x","z":null}]},"b":1}');
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test("capture and its hash do not depend on key order, and the stored-size measure follows JSONB text", () => {
  const { saved, ids, improve } = build();
  const first = captureInput(saved, improve([ids.a]));
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
  const reordered = reverse(first.capture);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(first.capture));
  assert.equal(canonicalJson(reordered), first.serialized);
  assert.equal(sha(canonicalJson(reordered)), first.hash);
  assert.equal(jsonbTextBytes({ a: [1, "é"], b: {} }), Buffer.byteLength('{"a": [1, "é"], "b": {}}'));
});

test("the 64 KiB start body bound rejects too many sources before any lookup and never truncates", () => {
  const entry = () => ({ sourceVersionId: randomUUID(), expectedCurrentVersionId: randomUUID() });
  const body = (count: number) => ({ taskType: "PROPOSE_FLOW", prompt: "go", draftId: randomUUID(), expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: Array.from({ length: count }, entry) } });
  assert.equal(parseStartRunInput(body(100), KEY).context.sources.length, 100);
  rejects(() => parseStartRunInput(body(600), KEY), "LIMIT_EXCEEDED");
  assert.throws(() => parseStartRunInput(body(600), KEY), (error) => error instanceof Error && error.cause === "START_BODY_BYTES");
  assert.equal(AI_LIMITS.startBodyBytes, 65_536);
  assert.equal(AI_LIMITS.admissionAttemptsPerMinute, 30);
});

test("lineStarts maps each normalized line to its code point offset", () => {
  assert.deepEqual(lineStarts(""), [0]);
  assert.deepEqual(lineStarts("a\n\nb \u{1F600}\n"), [0, 2, 3, 7]);
});
