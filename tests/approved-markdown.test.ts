import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { publishedFixture, addFlow, ids, requirement, reviewIds, NOW } from "./support/review-fixtures.ts";
import { lineStarts } from "../src/features/sources/contracts/source-version.ts";

async function formatter() {
  const exporter = await import("../src/features/exports/server/approved-markdown.ts").catch(() => null);
  assert.ok(exporter, "approved Markdown formatter exists");
  return exporter.formatApprovedMarkdown;
}

test("approved requirement-only Markdown pins exact immutable bytes and no export-time metadata", async () => {
  const format = await formatter(), published = publishedFixture();
  const first = format(published);
  assert.equal(first, golden);
  assert.equal(format(structuredClone(published)), first);
  assert.equal(first.includes("\r"), false);
  assert.ok(first.endsWith("\n") && !first.endsWith("\n\n"));
});

test("hostile multiline text stays inert while included graphs, background, verification and old citations remain complete and sorted", async () => {
  const format = await formatter(), published = publishedFixture(), s = published.snapshot, doc = s.documentJson;
  addFlow({ id: s.sourceDraftId, status: "EDITABLE", documentRevision: 1, layoutRevision: 1, document: doc, layout: s.layoutJson });
  const hostile = "# heading\n```[click](https://evil.example) | <img src=x> &\n    - nested\nhttps://evil.example www.evil.example me@evil.example 🙂";
  s.projectName = hostile; doc.projectGoal = hostile; published.decision.comment = hostile;
  doc.flows[ids.flow].purpose = hostile; doc.nodes[ids.node].description = hostile;
  doc.nodes[ids.node].actorLabel = "<actor>"; doc.nodes[ids.node].assumptionNotes = [hostile];
  doc.edges[reviewIds.edge].condition = hostile;
  doc.requirements[ids.req].statement = hostile;
  doc.requirements[ids.req].verificationMethod = { description: hostile, responsibleRole: "QA | role", reviewedBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
  doc.requirements[ids.other] = requirement({ id: ids.other, displayId: "REQ-002", title: "Background", inclusion: "UNDECIDED" });
  const excludedId = "40000000-0000-4000-8000-000000000001";
  doc.requirements[excludedId] = requirement({ id: excludedId, displayId: "REQ-003", title: "Excluded", inclusion: "EXCLUDED" });
  doc.traceLinks[ids.link] = { id: ids.link, version: 1, requirementId: ids.req, nodeId: ids.node, explanation: hostile, reviewedBy: ids.actor, reviewedAt: NOW, reviewedRequirementBehaviourVersion: 1, reviewedNodeBehaviourVersion: 1 };
  const sourceText = "old first\nold evidence\n", versionId = "40000000-0000-4000-8000-000000000002";
  s.evidenceManifest = [{ id: versionId, sourceId: reviewIds.source, kind: "USER_TEXT", sequence: 3, title: hostile, text: sourceText, lineStarts: lineStarts(sourceText), origin: { title: hostile }, contentHash: createHash("sha256").update(sourceText).digest("hex"), codePointCount: [...sourceText].length, utf8ByteCount: Buffer.byteLength(sourceText), createdBy: ids.actor, createdAt: NOW }];
  doc.requirements[ids.req].sourceRefs = [{ sourceVersionId: versionId, startLine: 2, endLine: 2, excerpt: "old evidence" }];
  const output = format(published);
  for (const text of ["## Included scope", "## Excluded", "## Undecided / exploratory background", "Background is not approved.", "## Reviewed included links", "## Intended verification definitions", "Definitions are intended checks, not executed results.", "## Captured evidence", "Direction: TB", `From: ${ids.node}`, `To: ${reviewIds.outcome}`, "Branch label:", "Source version: " + versionId + "; lines 2-2", "Version sequence: 3", "old evidence", "REQ-002", "REQ-003", "QA \\| role", "Assumption:"]) assert.ok(output.includes(text), text);
  for (const text of ["<img", "[click](", "```", "https://", "www.evil", "me@evil", "\n# heading", "\n    - nested"]) assert.equal(output.includes(text), false, text);
  assert.ok(output.includes("&lt;img src\\=x&gt; &amp;"));
  assert.ok(output.includes("> \\# heading\n> \\`\\`\\`\\[click\\]\\(https&#58;"));
  assert.ok(output.includes("> &#32;&#32;&#32;&#32;\\- nested"));
  assert.ok(output.includes("🙂"));
  doc.requirements = Object.fromEntries(Object.entries(doc.requirements).reverse());
  doc.nodes = Object.fromEntries(Object.entries(doc.nodes).reverse());
  assert.equal(format(published), output);
});

test("user text cannot turn quoted equals lines into Setext headings", async () => {
  const format = await formatter(), published = publishedFixture();
  published.snapshot.documentJson.projectGoal = "Heading\r\n===\r\nSingle\r\n=\r\nleft=right";
  const output = format(published);
  assert.ok(output.includes("Project goal:\n\n> Heading\n> \\=\\=\\=\n> Single\n> \\=\n> left\\=right\n\n"));
  assert.equal(output.includes("\n> ===\n"), false);
  assert.equal(output.includes("\n> =\n"), false);
});

test("approval attribution retains the captured named actor, role and authoritative ID", async () => {
  const format = await formatter(), published = publishedFixture();
  const output = format(published);
  assert.ok(output.includes("Approved actor name:\n\n> Named reviewer\n\n"));
  assert.ok(output.includes("Approved actor role: REVIEWER"));
  assert.ok(output.includes(`Approved actor ID: ${ids.actor}`));
  assert.equal(output.includes("Self/internal approval"), false);
  published.decision.actorRole = "OWNER";
  assert.ok(format(published).includes("Approval type: Self/internal approval"));
  published.decision.actorRole = "EDITOR";
  assert.ok(format(published).includes("Approved actor role: EDITOR"));
  assert.equal(format(published).includes("Self/internal approval"), false);
});

test("approval names are inert captured text and legacy attribution is explicitly unknown", async () => {
  const format = await formatter(), published = publishedFixture();
  published.decision.actorDisplayName = "# Named <img> [click](https://evil.example)\n===\nme@evil.example";
  const output = format(published);
  assert.ok(output.includes("Approved actor name:\n\n> \\# Named &lt;img&gt; \\[click\\]\\(https&#58;"));
  assert.ok(output.includes("\n> \\=\\=\\=\n"));
  assert.equal(output.includes("https://evil.example"), false);
  assert.equal(output.includes("me@evil.example"), false);
  assert.equal(format(structuredClone(published)), output);
  published.decision.actorDisplayName = null; published.decision.actorRole = null;
  const legacy = format(published);
  assert.ok(legacy.includes("Approved actor name:\n\n> Not captured\n\n"));
  assert.ok(legacy.includes("Approved actor role: Not captured"));
  assert.ok(legacy.includes(`Approved actor ID: ${ids.actor}`));
  assert.equal(legacy.includes("Self/internal approval"), false);
});

const golden = `# Approved scope

Project:

> Card checkout

Project goal:

> 

## Immutable approval

- Baseline sequence: 1
- Project ID: 30000000-0000-4000-8000-000000000001
- Snapshot ID: 30000000-0000-4000-8000-000000000002
- Review ID: 30000000-0000-4000-8000-000000000003
- Content hash: ${"a".repeat(64)}
- Review hash: ${"b".repeat(64)}
- Parent baseline: None
- Source draft: 20000000-0000-4000-8000-000000000001
- Captured revisions: document 1, layout 1
- Captured by ID: 10000000-0000-4000-8000-000000000005
- Captured at (UTC): 2026-10-07T10:00:00.000Z
- Approval policy version: 2
- Decision ID: 30000000-0000-4000-8000-000000000004
- Approved actor ID: 10000000-0000-4000-8000-000000000005
- Approved actor role: REVIEWER
- Approved at (UTC): 2026-10-07T10:00:00.000Z
- Published at (UTC): 2026-10-07T10:00:00.000Z

Approved actor name:

> Named reviewer

## Included scope

Only INCLUDED flows, requirements and their reviewed included links form the approved scope.

### Requirement REQ-001

- ID: 10000000-0000-4000-8000-000000000003
- Inclusion: INCLUDED
- Category: FUNCTIONAL
- Origin: HUMAN
- Owner ID: Unassigned
- Behaviour version: 1
- Confirmed by ID: 10000000-0000-4000-8000-000000000005
- Confirmed at (UTC): 2026-10-07T10:00:00.000Z

Title:

> Pay by card

Statement:

> 

## Excluded

Excluded items are not approved behavior.

None.

## Undecided / exploratory background

Background is not approved.

None.

## Reviewed included links

None.

## Background trace links

Background links are not approved.

None.

## Intended verification definitions

Definitions are intended checks, not executed results.

None.

## Captured evidence

Exact immutable source versions; citations above retain their original line ranges.

None.
`;
