import assert from "node:assert/strict";
import test from "node:test";
import { emptyDraft, type DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { parseExportRequest } from "../src/features/exports/contracts/flow-export.ts";
import { exportFilename, nativeFlowFile } from "../src/features/exports/domain/flow-file.ts";
import { parseFlowFile, serializeFlowFile } from "../src/features/exchange/domain/flow-file.ts";

const flowId = "10000000-0000-4000-8000-000000000001";
const otherFlow = "10000000-0000-4000-8000-000000000002";
const nodeIds = [3, 4, 5, 6, 7].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const edgeId = "10000000-0000-4000-8000-000000000008";
const exportedAt = "2026-10-02T00:00:00.000Z";

function saved(): DraftView {
  const draft: DraftView = { id: "10000000-0000-4000-8000-000000000009", status: "EDITABLE", documentRevision: 9, layoutRevision: 12, ...emptyDraft() };
  draft.document.flows[flowId] = { id: flowId, version: 2, behaviourVersion: 3, title: "Đặt chỗ", purpose: "A saved purpose", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null };
  draft.document.flows[otherFlow] = { ...draft.document.flows[flowId], id: otherFlow, title: "Other" };
  draft.layout.directions = { [flowId]: "LR", [otherFlow]: "TB" };
  for (const [index, kind] of (["START", "ACTION", "DECISION", "DATA_STORE", "OUTCOME"] as const).entries()) {
    const id = nodeIds[index]!;
    draft.document.nodes[id] = { id, flowId, version: 4, behaviourVersion: 5, kind, label: `Saved ${kind}`, description: "Unicode café\ntext", actorLabel: index ? "Người dùng" : "", origin: "AI_SUGGESTED", sourceRefs: [], assumptionNotes: ["Assumption"] };
    draft.layout.positions[id] = { x: -50 + index * 200, y: index * 100, version: 3 };
  }
  draft.document.edges[edgeId] = { id: edgeId, flowId, version: 4, fromId: nodeIds[2]!, toId: nodeIds[2]!, condition: "Retry?", origin: "IMPORTED", sourceRefs: [] };
  draft.layout.edgeSides[edgeId] = { from: "bottom", to: "right" };
  return draft;
}

test("export request admits only native saved revision pairs and defaults hints off", () => {
  assert.deepEqual(parseExportRequest({ format: "native", expectedDocumentRevision: 9, expectedLayoutRevision: 12 }), { format: "native", expectedDocumentRevision: 9, expectedLayoutRevision: 12, includeLinkHints: false });
  const valid = { format: "native", expectedDocumentRevision: 9, expectedLayoutRevision: 12, includeLinkHints: false };
  assert.deepEqual(parseExportRequest(valid), valid);
  for (const input of [null, [], { ...valid, format: "png" }, { ...valid, includeLinkHints: true }, { ...valid, includeLinkHints: null }, { ...valid, expectedDocumentRevision: 0 }, { ...valid, expectedLayoutRevision: 1.5 }, { ...valid, expectedLayoutRevision: 2_147_483_648 }, { ...valid, file: {} }, { ...valid, key: "key" }]) {
    assert.throws(() => parseExportRequest(input), /INVALID_INPUT/);
  }
  const { expectedLayoutRevision: omitted, ...missing } = valid;
  void omitted;
  assert.throws(() => parseExportRequest(missing), /INVALID_INPUT/);
});

test("native adapter exports only supported saved text and complete remapped geometry", () => {
  const draft = saved(); const before = structuredClone(draft);
  const file = nativeFlowFile(draft, flowId, exportedAt);
  assert.deepEqual(file, {
    format: "scoperoom-flow", formatVersion: 1, exportedAt, producerVersion: "1.6",
    flow: { title: "Đặt chỗ", purpose: "A saved purpose", classification: "BUSINESS_PROCESS", direction: "LR" },
    nodes: ["START", "ACTION", "DECISION", "DATA_STORE", "OUTCOME"].map((kind, index) => ({ id: `n${index + 1}`, kind, label: `Saved ${kind}`, description: "Unicode café\ntext", actorLabel: index ? "Người dùng" : null, assumptionNotes: ["Assumption"] })),
    edges: [{ id: "e1", fromId: "n3", toId: "n3", condition: "Retry?" }],
    origin: { kind: "DRAFT", documentRevision: 9, layoutRevision: 12 },
    positions: [{ nodeId: "n1", x: -50, y: 0 }, { nodeId: "n2", x: 150, y: 100 }, { nodeId: "n3", x: 350, y: 200 }, { nodeId: "n4", x: 550, y: 300 }, { nodeId: "n5", x: 750, y: 400 }],
    edgeSides: [{ edgeId: "e1", from: "bottom", to: "right" }],
  });
  assert.deepEqual(parseFlowFile(serializeFlowFile(file)), file);
  assert.deepEqual(draft, before);
  file.nodes[0]!.assumptionNotes.push("local");
  assert.deepEqual(draft, before, "prepared file owns its arrays");
});

test("empty flow exports explicit empty geometry without canvas defaults", () => {
  const draft = saved(); draft.document.nodes = {}; draft.document.edges = {}; draft.layout.positions = {}; draft.layout.edgeSides = {};
  const file = nativeFlowFile(draft, flowId, exportedAt);
  assert.deepEqual(file.positions, []); assert.deepEqual(file.edgeSides, []); assert.deepEqual(file.nodes, []);
  assert.equal(file.viewport, undefined); assert.equal(file.linkHints, undefined);
});

test("portable filename preserves Unicode while blocking paths controls bidi and reserved names", () => {
  for (const [title, expected] of [["Đặt chỗ", "Đặt chỗ"], ["a/b\\c:<d>\"|?*", "a_b_c__d_____"], ["a\r\n\u0000\u007f\u202eb", "a_____b"], ["...  ", "flow"], ["CON", "flow"], ["con.txt", "flow"], ["LPT9.report", "flow"], [" Name. ", "Name"], ["", "flow"]]) {
    assert.equal(exportFilename(title!), `${expected}.scoperoom-flow.json`);
  }
  const filename = exportFilename("😀".repeat(120));
  assert.equal(filename, `${"😀".repeat(50)}.scoperoom-flow.json`);
  assert(new TextEncoder().encode(filename).length < 255);
});
