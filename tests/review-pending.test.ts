import assert from "node:assert/strict";
import test from "node:test";
import { savedPendingWork } from "../src/features/reviews/ui/pending-work.ts";
import { candidateFixture, publishedFixture, addFlow, ids } from "./support/review-fixtures.ts";

const statusFor = (draft: ReturnType<typeof candidateFixture>["draft"], snapshotId: string | null) => ({ currentDraftId: draft.id, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, approvedSnapshotId: snapshotId, baselineSequence: 1 });
test("pending saved meaning follows current approved B through A to B to A and ignores counters and confirmations", () => {
  const published = publishedFixture(), draft = structuredClone(candidateFixture().draft);
  draft.document.projectGoal = "A";
  published.snapshot.documentJson.projectGoal = "B";
  const status = statusFor(draft, published.snapshot.id);
  assert.deepEqual(savedPendingWork(draft, published, status, undefined, true), { kind: "compared", semantic: true, layout: false });
  draft.document.projectGoal = "B"; draft.documentRevision += 2;
  draft.document.requirements[ids.req]!.version += 2;
  draft.document.requirements[ids.req]!.confirmation = null;
  assert.deepEqual(savedPendingWork(draft, published, status, undefined, true), { kind: "compared", semantic: false, layout: false });
  draft.document.projectGoal = "A";
  assert.equal(savedPendingWork(draft, published, status, undefined, true).kind, "compared");
  assert.deepEqual(savedPendingWork(draft, published, status, undefined, true), { kind: "compared", semantic: true, layout: false });
});
test("layout-only saved work uses geometry, directions and sides with order-independent keys", () => {
  const { draft } = candidateFixture(); addFlow(draft);
  const published = publishedFixture(); published.snapshot.documentJson = structuredClone(draft.document); published.snapshot.layoutJson = structuredClone(draft.layout);
  draft.layout.positions = Object.fromEntries(Object.entries(draft.layout.positions).reverse());
  for (const position of Object.values(draft.layout.positions)) position.version += 5;
  const status = statusFor(draft, published.snapshot.id);
  assert.deepEqual(savedPendingWork(draft, published, status, undefined, true), { kind: "compared", semantic: false, layout: false });
  for (const change of [() => { draft.layout.positions[ids.node]!.x++; }, () => { draft.layout.directions[ids.flow] = "LR"; }, () => { draft.layout.edgeSides["edge"] = { from: "left", to: "right" }; }]) {
    change(); assert.deepEqual(savedPendingWork(draft, published, status, undefined, true), { kind: "compared", semantic: false, layout: true });
    draft.layout = structuredClone(published.snapshot.layoutJson);
  }
});
test("unavailable, stale, wrong historical baseline and below-floor saved views never claim no pending work", () => {
  const { draft } = candidateFixture(), published = publishedFixture(), status = statusFor(draft, published.snapshot.id);
  for (const [saved, baseline, next, floor, valid] of [
    [draft, published, status, undefined, false],
    [draft, null, status, undefined, true],
    [draft, published, { ...status, currentDraftId: "other" }, undefined, true],
    [draft, published, { ...status, documentRevision: 2 }, undefined, true],
    [draft, published, { ...status, layoutRevision: 2 }, undefined, true],
    [draft, published, { ...status, approvedSnapshotId: "historical" }, undefined, true],
    [draft, published, { ...status, baselineSequence: 2 }, undefined, true],
    [draft, published, status, { documentRevision: 2, layoutRevision: 1 }, true],
    [draft, published, status, { documentRevision: 1, layoutRevision: 2 }, true],
  ] as const) assert.deepEqual(savedPendingWork(saved, baseline, next, floor, valid), { kind: "unavailable" });
  assert.deepEqual(savedPendingWork(draft, null, { ...status, approvedSnapshotId: null }, undefined, true), { kind: "unapproved" });
});
