import assert from "node:assert/strict";
import test from "node:test";
import { candidateFixture, addFlow, ids } from "./support/review-fixtures.ts";
import { candidateHashes } from "../src/features/reviews/server/snapshot.ts";
import { parseCandidatePayload, type CandidatePayload } from "../src/features/reviews/contracts/review.ts";
const payload = (): CandidatePayload => {
  const { draft } = candidateFixture();
  addFlow(draft);
  return {
    canonicalizationVersion: 1, schemaVersion: 3, projectId: ids.other, projectName: "Exact project", sourceDraftId: draft.id, capturedDocumentRevision: 1, capturedLayoutRevision: 1, documentJson: draft.document, layoutJson: draft.layout, evidenceManifest: [], policySnapshot: {
      designatedApproverId: ids.actor, approvalPolicyVersion: 1
    }, parentSnapshotId: null, agreementIntent: "INCLUDED_SCOPE", requestResolution: null
  };
};
test("candidate hash golden vector excludes its own hashes and immutable creation metadata", () => {
  assert.deepEqual(candidateHashes(payload()), {
    contentHash: "9eb5c9da1d1752e17a8fd237af27a504cb49a2b682e1187957dde30f256750e5", reviewHash: "07607e35ca90cfc184e49dc5c3a4d76d9246cb6480f2a32404f8da9542d4f509"
  });
});
test("recursive key permutation and JSON wire roundtrip preserve both hashes", () => {
  const original = payload();
  const permute = (value: unknown): unknown => Array.isArray(value) ? value.map(permute) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, permute(entry)])) : value;
  assert.deepEqual(candidateHashes(permute(original) as CandidatePayload), candidateHashes(original));
  assert.deepEqual(candidateHashes(JSON.parse(JSON.stringify(original))), candidateHashes(original));
});
test("confirmation stamps change contentHash; layout and policy change reviewHash only; publication changes neither", () => {
  const original = payload(), hashes = candidateHashes(original), stamp = structuredClone(original);
  stamp.documentJson.flows[ids.flow].confirmation!.confirmedAt = "2026-10-08T10:00:00.000Z";
  assert.notEqual(candidateHashes(stamp).contentHash, hashes.contentHash);
  for (const edit of [(value: CandidatePayload) => { value.layoutJson.positions[ids.node].x = 1.25; }, (value: CandidatePayload) => { value.policySnapshot.approvalPolicyVersion = 2; }]) {
    const changed = structuredClone(original);
    edit(changed);
    const result = candidateHashes(changed);
    assert.equal(result.contentHash, hashes.contentHash);
    assert.notEqual(result.reviewHash, hashes.reviewHash);
  }
  const review = {
    publicationSequence: null as number | null, publishedAt: null as string | null
  };
  review.publicationSequence = 1;
  review.publishedAt = "2026-10-09T10:00:00.000Z";
  assert.deepEqual(candidateHashes(original), hashes);
});
test("candidate payload rejects unsupported numbers, surrogates, unknown keys", () => {
  for (const edit of [(value: CandidatePayload) => { value.layoutJson.positions[ids.node].x = Infinity; }, (value: CandidatePayload) => { value.projectName = '\ud800'; }, (value: CandidatePayload) => { Object.assign(value, {
      unexpected: true
    }); }, (value: CandidatePayload) => { Object.assign(value.policySnapshot, {
      unexpected: true
    }); }]) {
    const value = payload();
    edit(value);
    assert.throws(() => parseCandidatePayload(value), {
      message: "INVALID_INPUT"
    });
  }
});
