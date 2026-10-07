import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { citationMatches, lineStarts, normalizeEvidence, parseCorrectSource, parseCreateSource, parseUpdateSource } from "../src/features/sources/contracts/source-version.ts";
import { graphExtract } from "../src/features/sources/domain/graph-extract.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("normalization drops one BOM and turns CRLF/CR into LF only", () => {
  // A second leading BOM survives normalization; the server then refuses it (the stored-text CHECK forbids a leading BOM).
  assert.equal(normalizeEvidence("\uFEFF\uFEFFa\r\nb\rc\n"), "\uFEFFa\nb\nc\n");
  assert.deepEqual(lineStarts(normalizeEvidence("a\r\nbb\r\nc")), [0, 2, 5]);
});

test("a citation needs its excerpt inside its own inclusive line range", () => {
  const text = "alpha\nbeta gamma\ndelta";
  assert.equal(citationMatches(text, { startLine: 2, endLine: 2, excerpt: "beta" }), true);
  assert.equal(citationMatches(text, { startLine: 1, endLine: 2, excerpt: "alpha\nbeta" }), true);
  assert.equal(citationMatches(text, { startLine: 1, endLine: 1, excerpt: "delta" }), false, "quote outside the range");
  assert.equal(citationMatches(text, { startLine: 3, endLine: 4, excerpt: "delta" }), false, "range past the last line");
  assert.equal(citationMatches(text, { startLine: 2, endLine: 2, excerpt: "invented" }), false);
});

test("source inputs are strict", () => {
  assert.deepEqual(parseCreateSource({ title: "Brief", text: "x" }), { title: "Brief", text: "x", uploaded: false });
  assert.equal(parseCreateSource({ title: "Brief", text: "x", uploaded: true }).uploaded, true);
  assert.throws(() => parseCreateSource({ title: "", text: "x" }));
  assert.throws(() => parseCreateSource({ title: "Brief", text: "x", kind: "AI_PROMPT" }), "the server assigns kind");
  assert.throws(() => parseCreateSource({ title: "Brief", text: "\ud800" }), "lone surrogate");
  assert.throws(() => parseCorrectSource({ expectedSourceRecordVersion: 1, title: "t", text: "x" }), "head is required");
  assert.deepEqual(parseUpdateSource({ expectedSourceRecordVersion: 2, archived: true }), { expectedSourceRecordVersion: 2, archived: true });
  assert.throws(() => parseUpdateSource({ expectedSourceRecordVersion: 2 }), "a metadata edit changes something");
  assert.equal(parseCorrectSource({ expectedSourceRecordVersion: 1, expectedCurrentVersionId: ID, title: "t", text: "x" }).expectedCurrentVersionId, ID);
});

test("a saved-flow extract is deterministic and independent of record order", () => {
  const { document } = emptyDraft();
  const flowId = ID, a = "22222222-2222-4222-8222-222222222222", b = "33333333-3333-4333-8333-333333333333", e = "44444444-4444-4444-8444-444444444444";
  document.flows[flowId] = { id: flowId, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "Pay", classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: null, verificationMethod: null };
  const node = (id: string, kind: "START" | "ACTION", label: string) => ({ id, flowId, version: 1, behaviourVersion: 1, kind, label, description: "", actorLabel: "", origin: "HUMAN" as const, sourceRefs: [], assumptionNotes: [] });
  document.nodes[b] = node(b, "ACTION", "Pay");
  document.nodes[a] = node(a, "START", "Cart");
  document.edges[e] = { id: e, flowId, version: 1, fromId: a, toId: b, condition: "has items", origin: "HUMAN", sourceRefs: [] };
  const extract = graphExtract(document, flowId);
  assert.equal(extract.text, "Flow: Checkout\nPurpose: Pay\nSteps:\n- START Cart\n- ACTION Pay\nConnections:\n- Cart -> Pay [has items]");
  assert.deepEqual([extract.nodeIds, extract.edgeIds], [[a, b], [e]], "ids follow the extract lines");
  const reordered = structuredClone(document);
  reordered.nodes = { [a]: document.nodes[a]!, [b]: document.nodes[b]! };
  assert.deepEqual(graphExtract(reordered, flowId), extract);
  // Duplicate labels: the lines read the same, the ids tell them apart.
  const twin = "55555555-5555-4555-8555-555555555555";
  document.nodes[twin] = node(twin, "ACTION", "Pay");
  assert.deepEqual(graphExtract(document, flowId).nodeIds, [a, b, twin]);
  delete document.nodes[twin];
  document.nodes[b] = node(b, "ACTION", "Pay\r\nnow\rlater");
  const single = graphExtract(document, flowId).text;
  assert.ok(single.includes("- ACTION Pay now later"), "CR and CRLF in a label stay on one line");
  assert.equal(single, normalizeEvidence(single), "the extract is already normalized");
});
