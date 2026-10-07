import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { citationMatches, lineStarts, normalizeEvidence, parseCorrectSource, parseCreateSource, parseUpdateSource } from "../src/features/sources/contracts/source-version.ts";
import { graphExtract } from "../src/features/sources/domain/graph-extract.ts";
import { acceptFirstPage, appendSourcePage, appendVersionPage, canLoadMore, listKey, startSourceList } from "../src/features/sources/ui/source-pages.ts";
import { editSourceCorrection, reconcileSourceCorrection, sourceCorrectionBody } from "../src/features/sources/ui/source-correction.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("a correction pins both original fields and guards, and only explicit review merges changed fields", () => {
  const head = { version: 1, currentVersionId: "v1" }, view = { id: "v1", sequence: 1, title: "Original title", text: "Original text" };
  const newerHead = { version: 2, currentVersionId: "v2" }, newerView = { id: "v2", sequence: 2, title: "Remote title", text: "Remote text" };
  const titleOnly = editSourceCorrection(undefined, head, view, "title", "Local title")!;
  assert.deepEqual(sourceCorrectionBody(titleOnly), { expectedSourceRecordVersion: 1, expectedCurrentVersionId: "v1", title: "Local title", text: "Original text" });
  const typedAfterRefresh = editSourceCorrection(titleOnly, newerHead, newerView, "title", "Local title continued")!;
  assert.equal(typedAfterRefresh.base, titleOnly.base);
  assert.equal(typedAfterRefresh.text, "Original text");
  assert.equal(editSourceCorrection(undefined, newerHead, view, "title", "No mixed baseline"), undefined);
  const reviewed = reconcileSourceCorrection(typedAfterRefresh, newerHead, newerView)!;
  assert.deepEqual(sourceCorrectionBody(reviewed), { expectedSourceRecordVersion: 2, expectedCurrentVersionId: "v2", title: "Local title continued", text: "Remote text" });
  const textOnly = editSourceCorrection(undefined, head, view, "text", "Local text")!;
  assert.deepEqual(sourceCorrectionBody(reconcileSourceCorrection(textOnly, newerHead, newerView)!), { expectedSourceRecordVersion: 2, expectedCurrentVersionId: "v2", title: "Remote title", text: "Local text" });
  assert.equal(reconcileSourceCorrection(textOnly, newerHead, view), textOnly, "the reviewed body must belong to the selected head");
  assert.equal(editSourceCorrection(titleOnly, newerHead, newerView, "title", "Original title"), undefined, "undoing local edits releases the baseline");
});

test("version paging rejects held pages after a source change, head refresh or duplicate reply", () => {
  const item = (sequence: number) => ({ id: String(sequence), sequence, title: "Version", contentHash: "hash", codePointCount: 1, createdBy: ID, createdAt: "2026-10-07T10:00:00Z" });
  const first = { key: "project:source:head1:0", page: { items: [item(51)], nextCursor: 51 } };
  const next = { items: [item(50)], nextCursor: 50 };
  const joined = appendVersionPage(first, first.key, 51, next);
  assert.deepEqual(joined?.page.items.map((value) => value.sequence), [51, 50]);
  assert.equal(appendVersionPage(joined, first.key, 51, next), joined);
  for (const key of ["project:other:head1:0", "project:source:head2:0", "project:source:head1:1"]) {
    const refreshed = { ...first, key };
    assert.equal(appendVersionPage(refreshed, first.key, 51, next), refreshed);
  }
});

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

test("a later page joins only the list, load and cursor it was asked for", () => {
  const head = (id: string) => ({ id, kind: "USER_TEXT" as const, title: id, displayNickname: null, archived: false, version: 1, currentVersionId: id, currentSequence: 1, versionCount: 1, createdBy: id, createdAt: "2026-10-07T10:00:00.000Z" });
  const usage = { activeUserDocuments: 2, retainedVersions: 2, codePoints: 2 };
  const user = listKey("p1", "user"), archived = listKey("p1", "archived");
  const first = acceptFirstPage(user, 1, { items: [head("a")], nextCursor: "a", usage, sourcesRevision: 4 });
  const next = { items: [head("b")], nextCursor: null, usage, sourcesRevision: 4 };
  assert.deepEqual(appendSourcePage(first, user, 1, "a", next)?.page.items.map((item) => item.id), ["a", "b"]);
  assert.equal(appendSourcePage(first, user, 1, "z", next), first, "a page for another cursor is dropped");
  assert.equal(appendSourcePage(appendSourcePage(first, user, 1, "a", next), user, 1, "a", next)?.page.items.length, 2, "a page is never appended twice");

  // Filter change: the old list is cleared, so its cursor can never be sent under the new filter.
  assert.equal(startSourceList(first, archived), null);
  assert.equal(canLoadMore(startSourceList(first, archived), archived, 2), false);
  // Revision refresh on the same filter: rows stay visible, but More waits for the matching first page (held or failed).
  const refreshing = startSourceList(first, user);
  assert.equal(refreshing, first);
  assert.equal(canLoadMore(refreshing, user, 2), false, "ticket 2's first page has not been accepted");
  assert.equal(appendSourcePage(refreshing, user, 2, "a", next), refreshing, "an old cursor sent under the new load is dropped");
  assert.equal(canLoadMore(acceptFirstPage(user, 2, { ...first!.page }), user, 2), true);
});
