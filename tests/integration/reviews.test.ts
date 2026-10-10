import { executeGraphCommand } from "../../src/features/drafts/server/execute-command.ts";
import { savedPendingWork } from "../../src/features/reviews/ui/pending-work.ts";
import { parseCandidatePayload } from "../../src/features/reviews/contracts/review.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { canRun, withFixture, type Fixture } from "./support/fixture.ts";
import { candidateFixture, addFlow, ids } from "../support/review-fixtures.ts";
import * as reviewWrites from "../../src/features/reviews/server/reviews.ts";
import { freezeReview, previewReview, withdrawReview } from "../../src/features/reviews/server/reviews.ts";
import { listReviews, readReview } from "../../src/features/reviews/server/read-reviews.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { archiveProject, changeProjectMember, removeProjectMember, updateApprovalPolicy, updateProjectSettings, restoreProject, leaveProject } from "../../src/features/projects/server/management.ts";
import { savePositions } from "../../src/features/drafts/server/positions.ts";
import { correctSource, createSource, updateSource } from "../../src/features/sources/server/sources.ts";
import { candidateHashes } from "../../src/features/reviews/server/snapshot.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

// Audit-fault DDL takes a global project relation lock; do not queue it behind held-lock retention checks.
serializeSweeps();
const refused = (code: string) => (error: unknown) => error instanceof ProjectError && error.code === code;
async function prepared(f: Fixture, flow = false) {
  const owner = await f.user(), projectId = await f.project(owner), actorId = await f.profileId(owner);
  await updateApprovalPolicy(owner, projectId, {
    key: randomUUID(), expectedApprovalPolicyVersion: 1, designatedApproverId: actorId
  });
  const draft = (await getProjectBootstrap(owner, projectId)).draft, fixture = candidateFixture();
  if (flow) {
    addFlow(fixture.draft);
  }
  for (const record of [...Object.values(fixture.draft.document.requirements), ...Object.values(fixture.draft.document.flows)])
    if (record.confirmation) {
      record.confirmation.actorId = actorId;
    }
  await f.database.query("update app.scope_draft set document_json=$2,layout_json=$3 where id=$1", [draft.id, fixture.draft.document, fixture.draft.layout]);
  const input = {
    expectedDocumentRevision: 1, expectedLayoutRevision: 1, expectedParentSnapshotId: null, expectedApprovalPolicyVersion: 2
  };
  return {
    owner, projectId, actorId, draftId: draft.id, input, fixture
  };
}
async function counts(database: Client, projectId: string) { return (await database.query("select (select count(*)::int from app.scope_snapshot where project_id=$1) snapshots,(select count(*)::int from app.review_request where project_id=$1) reviews,(select count(*)::int from app.audit_event where project_id=$1) events,(select count(*)::int from app.mutation_receipt where scope_id=$1) receipts", [projectId])).rows[0]; }
test("candidate storage is installed with same-project lineage and immutable payload authority", {
  skip: !canRun
}, async () => { await withFixture(async ({ database }) => { assert.deepEqual((await database.query("select to_regclass('app.scope_snapshot')::text as snapshot,to_regclass('app.review_request')::text as review")).rows[0], {
  snapshot: "app.scope_snapshot", review: "app.review_request"
}); }); });
test("preview saves nothing; freeze is exact, immutable, hashed and same-key replay emits one event", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), before = await counts(f.database, projectId);
    const preview = await previewReview(owner, projectId, draftId, input);
    assert.deepEqual(preview.guards, input);
    assert.equal(preview.check.valid, true);
    assert.deepEqual(await counts(f.database, projectId), before);
    const key = randomUUID(), frozen = await freezeReview(owner, projectId, draftId, input, key), detail = await readReview(owner, projectId, frozen.reviewId);
    assert.equal(detail.snapshot.sourceDraftId, draftId);
    assert.deepEqual(candidateHashes(parseCandidatePayload(Object.fromEntries(Object.entries(detail.snapshot).filter(([key]) => !["id", "contentHash", "reviewHash", "createdBy", "createdAt"].includes(key))))), {
      contentHash: detail.snapshot.contentHash, reviewHash: frozen.reviewHash
    });
    assert.equal(detail.decision, null);
    assert.deepEqual(detail.draftChanges, {
      replaced: false, contentChanged: false, layoutChanged: false
    });
    const after = await counts(f.database, projectId);
    assert.deepEqual(after, {
      snapshots: 1, reviews: 1, events: before.events + 1, receipts: before.receipts + 1
    });
    assert.deepEqual(await freezeReview(owner, projectId, draftId, input, key), {
      ...frozen, replayed: true
    });
    assert.deepEqual(await counts(f.database, projectId), after);
    assert.equal((await getProjectStatus(owner, projectId)).reviewsRevision, frozen.eventSequence);
    assert.equal((await getProjectStatus(owner, projectId)).baselineSequence, 0);
    assert.equal((await listReviews(owner, projectId)).items[0].reviewId, frozen.reviewId);
    await assert.rejects(freezeReview(owner, projectId, draftId, input, randomUUID()), refused("ACTIVE_REVIEW_EXISTS"));
    await f.database.query("update app.scope_draft set document_revision=2,layout_revision=2,document_json=jsonb_set(document_json,'{projectGoal}','\"Newer goal\"'::jsonb) where id=$1", [draftId]);
    const newer = await readReview(owner, projectId, frozen.reviewId);
    assert.equal(newer.snapshot.documentJson.projectGoal, detail.snapshot.documentJson.projectGoal);
    assert.equal(newer.draftChanges.contentChanged, true);
    assert.equal(newer.draftChanges.layoutChanged, false);
    await assert.rejects(f.database.query("update app.scope_snapshot set payload=payload where id=$1", [frozen.snapshotId]), {
      code: "23514", constraint: "scope_snapshot_immutable"
    });
  });
});
for (const [field, value, code] of [["expectedDocumentRevision", 2, "STALE_DOCUMENT_REVISION"], ["expectedLayoutRevision", 2, "STALE_LAYOUT_REVISION"], ["expectedParentSnapshotId", randomUUID(), "BASELINE_CHANGED"], ["expectedApprovalPolicyVersion", 1, "REVIEW_POLICY_CHANGED"]] as const)
  test(`freeze rejects stale ${field} atomically`, {
    skip: !canRun
  }, async () => { await withFixture(async (f) => { const { owner, projectId, draftId, input } = await prepared(f), before = await counts(f.database, projectId); await assert.rejects(freezeReview(owner, projectId, draftId, {
    ...input, [field]: value
  }, randomUUID()), refused(code)); assert.deepEqual(await counts(f.database, projectId), before); }); });
test("roles, foreign review and source scopes are enforced; old immutable source versions are captured exactly", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input, fixture } = await prepared(f), viewer = await f.user(), reviewer = await f.user();
    await f.join(owner, projectId, viewer, "VIEWER");
    await f.join(owner, projectId, reviewer, "REVIEWER");
    assert.equal((await previewReview(viewer, projectId, draftId, input)).check.valid, true);
    for (const user of [viewer, reviewer])
      await assert.rejects(freezeReview(user, projectId, draftId, input, randomUUID()), refused("FORBIDDEN"));
    const source = await createSource(owner, projectId, {
      title: "Original title", text: "Exact evidence", key: randomUUID()
    });
    fixture.draft.document.requirements[ids.req].sourceRefs = [{
        sourceVersionId: source.sourceVersionId, startLine: 1, endLine: 1, excerpt: "Exact evidence"
      }];
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, fixture.draft.document]);
    await correctSource(owner, projectId, source.sourceId, {
      title: "New title", text: "Newer evidence", expectedSourceRecordVersion: 1, expectedCurrentVersionId: source.sourceVersionId, key: randomUUID()
    });
    await updateSource(owner, projectId, source.sourceId, {
      expectedSourceRecordVersion: 2, displayNickname: "Live nickname", key: randomUUID()
    });
    const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID()), detail = await readReview(viewer, projectId, frozen.reviewId);
    assert.equal(detail.snapshot.evidenceManifest[0].title, "Original title");
    assert.equal(detail.snapshot.evidenceManifest[0].text, "Exact evidence");
    const other = await f.project(owner);
    await assert.rejects(readReview(owner, other, frozen.reviewId), refused("NOT_FOUND"));
    await assert.rejects(withdrawReview(owner, other, frozen.reviewId, {
      expectedReviewVersion: 1, reason: "Close"
    }, randomUUID()), refused("NOT_FOUND"));
    await assert.rejects(f.database.query("update app.project set approved_snapshot_id=$2 where id=$1", [other, frozen.snapshotId]), {
      code: "23503", constraint: "project_approved_snapshot_fkey"
    });
    const foreign = await createSource(owner, other, {
      title: "Foreign", text: "Foreign evidence", key: randomUUID()
    });
    fixture.draft.document.requirements[ids.req].sourceRefs = [{
        sourceVersionId: foreign.sourceVersionId, startLine: 1, endLine: 1, excerpt: "Foreign"
      }];
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, fixture.draft.document]);
    await assert.rejects(previewReview(owner, projectId, draftId, input), refused("INVALID_SOURCE_REFERENCE"));
  });
});
test("withdrawal is audited, bounded, versioned and replayable; refreeze creates a new immutable candidate", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), frozen = await freezeReview(owner, projectId, draftId, input, randomUUID()), key = randomUUID();
    for (const reason of [" ", "𐀀".repeat(4001)])
      await assert.rejects(withdrawReview(owner, projectId, frozen.reviewId, {
        expectedReviewVersion: 1, reason
      }, key), refused("INVALID_INPUT"));
    await assert.rejects(withdrawReview(owner, projectId, frozen.reviewId, {
      expectedReviewVersion: 2, reason: "Later"
    }, key), refused("CONFLICT"));
    const result = await withdrawReview(owner, projectId, frozen.reviewId, {
      expectedReviewVersion: 1, reason: "𐀀".repeat(4000)
    }, key);
    assert.equal(result.reviewVersion, 2);
    assert.deepEqual(await withdrawReview(owner, projectId, frozen.reviewId, {
      expectedReviewVersion: 1, reason: "𐀀".repeat(4000)
    }, key), {
      ...result, replayed: true
    });
    assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.reason, "𐀀".repeat(4000));
    assert.notEqual((await freezeReview(owner, projectId, draftId, input, randomUUID())).snapshotId, frozen.snapshotId);
  });
});
test("policy no-op and unrelated settings keep OPEN; effective policy and archive supersede once, restore never revives", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input, actorId } = await prepared(f), frozen = await freezeReview(owner, projectId, draftId, input, randomUUID()), before = await getProjectStatus(owner, projectId);
    await updateApprovalPolicy(owner, projectId, {
      key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: actorId
    });
    assert.equal((await getProjectStatus(owner, projectId)).eventSequence, before.eventSequence);
    await updateProjectSettings(owner, projectId, {
      key: randomUUID(), expectedSettingsVersion: 1, name: "Updated title"
    });
    assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.state, "OPEN");
    await updateApprovalPolicy(owner, projectId, {
      key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: null
    });
    assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.state, "SUPERSEDED");
    await updateApprovalPolicy(owner, projectId, {
      key: randomUUID(), expectedApprovalPolicyVersion: 3, designatedApproverId: actorId
    });
    const second = await freezeReview(owner, projectId, draftId, {
      ...input, expectedApprovalPolicyVersion: 4
    }, randomUUID());
    await archiveProject(owner, projectId, {
      key: randomUUID(), expectedProjectVersion: 1, reason: "Archive"
    });
    assert.equal((await readReview(owner, projectId, second.reviewId)).review.state, "SUPERSEDED");
    await restoreProject(owner, projectId, {
      key: randomUUID(), expectedProjectVersion: 2
    });
    assert.equal((await readReview(owner, projectId, second.reviewId)).review.state, "SUPERSEDED");
  });
});
for (const action of ["remove", "leave", "downgrade"] as const)
  test(`designated approver ${action} invalidates OPEN and preserves audit sequencing`, {
    skip: !canRun
  }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, draftId, input } = await prepared(f), approver = await f.user();
      await f.join(owner, projectId, approver, "REVIEWER");
      const profileId = await f.profileId(approver);
      await updateApprovalPolicy(owner, projectId, {
        key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: profileId
      });
      const frozen = await freezeReview(owner, projectId, draftId, {
        ...input, expectedApprovalPolicyVersion: 3
      }, randomUUID());
      if (action === "remove") {
        await removeProjectMember(owner, projectId, profileId, {
          key: randomUUID(), expectedMemberVersion: 1
        });
      }
      else if (action === "leave") {
        await leaveProject(approver, projectId, {
          key: randomUUID()
        });
      }
      else
        await changeProjectMember(owner, projectId, profileId, {
          key: randomUUID(), expectedMemberVersion: 1, role: "VIEWER"
        });
      const detail = await readReview(owner, projectId, frozen.reviewId);
      assert.equal(detail.review.state, "SUPERSEDED");
      const status = await getProjectStatus(owner, projectId);
      assert.equal(status.eventSequence, detail.review.lastEventSequence + 1);
      assert.equal(status.reviewsRevision, detail.review.lastEventSequence);
    });
  });
test("freeze receipt replays after downgrade and archive but denies a removed member", {
  skip: !canRun
}, async () => { await withFixture(async (f) => { const { owner, projectId, draftId, input } = await prepared(f), editor = await f.user(); await f.join(owner, projectId, editor); const id = await f.profileId(editor), key = randomUUID(), frozen = await freezeReview(editor, projectId, draftId, input, key); await changeProjectMember(owner, projectId, id, {
  key: randomUUID(), expectedMemberVersion: 1, role: "VIEWER"
}); assert.equal((await freezeReview(editor, projectId, draftId, input, key)).replayed, true); await archiveProject(owner, projectId, {
  key: randomUUID(), expectedProjectVersion: 1, reason: "Close"
}); assert.equal((await freezeReview(editor, projectId, draftId, input, key)).replayed, true); await removeProjectMember(owner, projectId, id, {
  key: randomUUID(), expectedMemberVersion: 2
}); await assert.rejects(freezeReview(editor, projectId, draftId, input, key), refused("NOT_FOUND")); assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.state, "SUPERSEDED"); }); });
async function waitForWaiters(database: Client, pid: number, count: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await database.query<{
      count: number;
    }>(`with recursive chain(pid) as (select $1::int union select a.pid from pg_stat_activity a join chain c on c.pid=any(pg_blocking_pids(a.pid))) select count(*)::int count from pg_stat_activity a join chain c on c.pid=a.pid where a.wait_event_type='Lock'`, [pid]);
    if (row.count >= count) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Held-lock barrier did not observe ${count} waiting transactions.`);
}
async function barrier(f: Fixture, projectId: string, work: (holder: Client, pid: number) => Promise<void>) {
  const holder = new Client({
    connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL!
  });
  await holder.connect();
  await holder.query("begin");
  await holder.query("select id from app.project where id=$1 for update", [projectId]);
  const pid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await work(holder, pid);
  }
  finally {
    await holder.query("rollback");
    await holder.end();
  }
}
for (const sameKey of [true, false])
  test(`held project lock serializes two freezes with ${sameKey ? "identical" : "competing"} keys`, {
    skip: !canRun
  }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, draftId, input } = await prepared(f);
      const key = randomUUID();
      await barrier(f, projectId, async (holder, pid) => {
        const first = freezeReview(owner, projectId, draftId, input, key);
        await waitForWaiters(f.database, pid, 1);
        const second = freezeReview(owner, projectId, draftId, input, sameKey ? key : randomUUID());
        await waitForWaiters(f.database, pid, 2);
        await holder.query("commit");
        const results = await Promise.allSettled([first, second]);
        assert.equal(results[0].status, "fulfilled");
        if (sameKey) {
          assert.equal(results[1].status, "fulfilled");
          if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
            assert.equal(results[0].value.snapshotId, results[1].value.snapshotId);
            assert.equal(results[1].value.replayed, true);
          }
        }
        else {
          assert.equal(results[1].status, "rejected");
          if (results[1].status === "rejected") {
            assert.ok(refused("ACTIVE_REVIEW_EXISTS")(results[1].reason));
          }
        }
        assert.equal((await counts(f.database, projectId)).snapshots, 1);
      });
    });
  });
for (const first of ["freeze", "move"] as const)
  test(`held barrier freeze versus move: ${first} obtains project lock first`, {
    skip: !canRun
  }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, draftId, input } = await prepared(f, true);
      await barrier(f, projectId, async (holder, pid) => {
        const freeze = () => freezeReview(owner, projectId, draftId, input, randomUUID());
        const move = () => savePositions(owner, projectId, draftId, {
          key: randomUUID(), mode: "MOVE_NODES", flowId: ids.flow, items: [{
              nodeId: ids.node, expectedPositionVersion: 1, x: 25.5, y: 37
            }]
        });
        const a = first === "freeze" ? freeze() : move();
        await waitForWaiters(f.database, pid, 1);
        const b = first === "freeze" ? move() : freeze();
        await waitForWaiters(f.database, pid, 2);
        await holder.query("commit");
        const [one, two] = await Promise.allSettled([a, b]);
        assert.equal(one.status, "fulfilled");
        if (first === "move") {
          assert.equal(two.status, "rejected");
          if (two.status === "rejected") {
            assert.ok(refused("STALE_LAYOUT_REVISION")(two.reason));
          }
          assert.equal((await counts(f.database, projectId)).snapshots, 0);
        }
        else {
          assert.equal(two.status, "fulfilled");
          if (one.status === "fulfilled" && "reviewId" in one.value) {
            const detail = await readReview(owner, projectId, one.value.reviewId);
            assert.equal(detail.snapshot.layoutJson.positions[ids.node].x, 0);
            assert.equal(detail.draftChanges.layoutChanged, true);
          }
        }
      });
    });
  });
for (const change of ["policy", "archive"] as const)
  for (const first of ["freeze", "change"] as const)
    test(`held barrier freeze versus ${change}: ${first} obtains project lock first`, {
      skip: !canRun
    }, async () => {
      await withFixture(async (f) => {
        const { owner, projectId, draftId, input } = await prepared(f);
        await barrier(f, projectId, async (holder, pid) => {
          const freeze = () => freezeReview(owner, projectId, draftId, input, randomUUID());
          const edit = () => change === "policy" ? updateApprovalPolicy(owner, projectId, {
            key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: null
          }) : archiveProject(owner, projectId, {
            key: randomUUID(), expectedProjectVersion: 1, reason: "Close"
          });
          const a = first === "freeze" ? freeze() : edit();
          await waitForWaiters(f.database, pid, 1);
          const b = first === "freeze" ? edit() : freeze();
          await waitForWaiters(f.database, pid, 2);
          await holder.query("commit");
          const [one, two] = await Promise.allSettled([a, b]);
          assert.equal(one.status, "fulfilled");
          if (first === "change") {
            assert.equal(two.status, "rejected");
            if (two.status === "rejected") {
              assert.ok(refused(change === "policy" ? "REVIEW_POLICY_CHANGED" : "CONFLICT")(two.reason));
            }
            assert.equal((await counts(f.database, projectId)).snapshots, 0);
          }
          else {
            assert.equal(two.status, "fulfilled");
            if (one.status === "fulfilled" && "reviewId" in one.value) {
              assert.equal((await readReview(owner, projectId, one.value.reviewId)).review.state, "SUPERSEDED");
            }
          }
        });
      });
    });
test("candidate over full envelope cap rolls back without truncating valid document or evidence", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input, fixture } = await prepared(f), refs = [];
    for (let index = 0; index < 10; index++) {
      const source = await createSource(owner, projectId, {
        key: randomUUID(), title: `Source ${index}`, text: "\u0001".repeat(50000)
      });
      refs.push({
        sourceVersionId: source.sourceVersionId, startLine: 1, endLine: 1, excerpt: "\u0001"
      });
    }
    const original = fixture.draft.document.requirements[ids.req];
    fixture.draft.document.requirements = {};
    for (let index = 0; index < 60; index++) {
      const id = randomUUID();
      fixture.draft.document.requirements[id] = {
        ...original, id, displayId: `REQ-${String(index + 1).padStart(3, "0")}`, statement: "\u0001".repeat(4000), sourceRefs: index < 10 ? [refs[index]] : []
      };
    }
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, fixture.draft.document]);
    const before = await counts(f.database, projectId);
    await assert.rejects(freezeReview(owner, projectId, draftId, input, randomUUID()), refused("LIMIT_EXCEEDED"));
    assert.deepEqual(await counts(f.database, projectId), before);
  });
});
test("audit failure rolls back candidate, cursor and receipt in the same real transaction", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), before = await counts(f.database, projectId), status = await getProjectStatus(owner, projectId), name = `test_review_${randomUUID().replaceAll("-", "")}`;
    await f.database.query("begin");
    try {
      await f.database.query("lock table app.project in exclusive mode");
      await f.database.query(`create function app.${name}() returns trigger language plpgsql as $$ begin if NEW.project_id='${projectId}'::uuid and NEW.action='REVIEW_FROZEN' then raise exception 'test audit failure' using errcode='23514'; end if; return NEW; end; $$; create trigger ${name} before insert on app.audit_event for each row execute function app.${name}()`);
      await f.database.query("commit");
    } catch (error) { await f.database.query("rollback"); throw error; }
    try {
      await assert.rejects(freezeReview(owner, projectId, draftId, input, randomUUID()), refused("UNAVAILABLE"));
      assert.deepEqual(await counts(f.database, projectId), before);
      assert.deepEqual(await getProjectStatus(owner, projectId), status);
    }
    finally {
      // Drain project writers before DDL takes downstream audit/Realtime relation locks.
      await f.database.query("begin");
      try {
        await f.database.query("lock table app.project in exclusive mode");
        await f.database.query(`drop trigger ${name} on app.audit_event;drop function app.${name}()`);
        await f.database.query("commit");
      } catch (error) { await f.database.query("rollback"); throw error; }
    }
  });
});
test("history summaries do not fetch candidate payloads; detail reads still do", {
  skip: !canRun
}, async (context) => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f);
    const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    const queries = context.mock.method(Client.prototype, "query");
    try {
      const history = await listReviews(owner, projectId);
      assert.equal(history.items[0].reviewHash, frozen.reviewHash);
      const snapshotQueries = () => queries.mock.calls.map(({ arguments: [query] }) => {
        const value: unknown = query;
        return typeof value === "string" ? value : value && typeof value === "object" && "text" in value ? String(value.text) : "";
      }).filter(sql => /\bscope_snapshot\b/.test(sql));
      assert.ok(snapshotQueries().length > 0, "observed real candidate SQL");
      assert.ok(snapshotQueries().every(sql => !/\bpayload\b/.test(sql)), "history must not transfer immutable candidate bodies");
      queries.mock.resetCalls();
      assert.equal((await readReview(owner, projectId, frozen.reviewId)).snapshot.reviewHash, frozen.reviewHash);
      assert.ok(snapshotQueries().some(sql => /\bpayload\b/.test(sql)), "detail still loads the complete candidate for integrity checks");
    } finally {
      queries.mock.restore();
    }
  });
});
test("snapshot corruption and hash mismatch fail closed without substituting newer work", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    for (const field of ["hash", "payload"]) {
      await f.database.query("begin");
      try {
        await f.database.query("alter table app.scope_snapshot disable trigger scope_snapshot_immutable");
        if (field === "hash") {
          await f.database.query("update app.scope_snapshot set review_hash=repeat('0',64) where id=$1", [frozen.snapshotId]);
        }
        else
          await f.database.query("update app.scope_snapshot set review_hash=$2,payload=jsonb_set(payload,'{documentJson,requirements,$id,unexpected}','true'::jsonb) where id=$1".replace('$id', ids.req), [frozen.snapshotId, frozen.reviewHash]);
        await f.database.query("alter table app.scope_snapshot enable trigger scope_snapshot_immutable");
        await f.database.query("commit");
      }
      catch (error) {
        await f.database.query("rollback");
        throw error;
      }
      const history = await listReviews(owner, projectId);
      assert.equal(history.items[0].reviewId, frozen.reviewId);
      assert.equal(history.items[0].reviewHash, field === "hash" ? "0".repeat(64) : frozen.reviewHash);
      await assert.rejects(readReview(owner, projectId, frozen.reviewId), refused("UNAVAILABLE"));
    }
  });
});
test("SQL rejects fabricated publication and wrong immutable bindings, with exact FK/CHECK names", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    const runtime = new Client({
      connectionString: process.env.DATABASE_URL!
    });
    await runtime.connect();
    await runtime.query("set role app_web");
    try {
      const copy = `insert into app.review_request(id,project_id,candidate_snapshot_id,source_draft_id,parent_snapshot_id,designated_approver_id,approval_policy_version,state,version,last_event_sequence,publication_sequence,published_at,created_by,created_at) select gen_random_uuid(),project_id,candidate_snapshot_id,source_draft_id,parent_snapshot_id,designated_approver_id,approval_policy_version,$2::app.review_state,1,last_event_sequence,$3::bigint,$4::timestamptz,created_by,created_at from app.review_request where id=$1`;
      await assert.rejects(runtime.query(copy, [frozen.reviewId, "APPROVED", 1, new Date()]), {
        code: "23514", constraint: "review_request_initial_state"
      });
      await assert.rejects(runtime.query("insert into app.review_request(id,project_id,candidate_snapshot_id,source_draft_id,designated_approver_id,approval_policy_version,last_event_sequence,created_by,created_at) select gen_random_uuid(),project_id,candidate_snapshot_id,source_draft_id,designated_approver_id,approval_policy_version+1,last_event_sequence,created_by,created_at from app.review_request where id=$1", [frozen.reviewId]), {
        code: "23514", constraint: "review_request_candidate_binding"
      });
      await assert.rejects(runtime.query("update app.review_request set candidate_snapshot_id=$2 where id=$1", [frozen.reviewId, randomUUID()]), {
        code: "42501"
      });
    }
    finally {
      await runtime.end();
    }
    await assert.rejects(f.database.query("update app.review_request set source_draft_id=$2 where id=$1", [frozen.reviewId, randomUUID()]), {
      code: "23514", constraint: "review_request_immutable_binding"
    });
    await f.database.query("begin");
    try {
      await f.database.query("alter table app.review_request disable trigger review_request_binding");
      await f.database.query("alter table app.review_request disable trigger review_request_candidate_binding_check");
      await assert.rejects(f.database.query("update app.review_request set state='APPROVED',publication_sequence=null,published_at=current_timestamp where id=$1", [frozen.reviewId]), {
        code: "23514", constraint: "review_request_publication"
      });
    }
    finally {
      await f.database.query("rollback");
    }
    const other = await f.project(owner), otherDraft = (await getProjectBootstrap(owner, other)).draft.id;
    await assert.rejects(f.database.query("update app.scope_draft set base_snapshot_id=$2 where id=$1", [otherDraft, frozen.snapshotId]), {
      code: "23503", constraint: "scope_draft_base_snapshot_fkey"
    });
    await assert.rejects(f.database.query("insert into app.scope_snapshot(id,project_id,source_draft_id,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,payload,content_hash,review_hash,created_by,created_at) select gen_random_uuid(),project_id,$2::uuid,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,jsonb_set(payload,'{sourceDraftId}',to_jsonb(($2::uuid)::text)),content_hash,review_hash,created_by,created_at from app.scope_snapshot where id=$1", [frozen.snapshotId, otherDraft]), {
      code: "23503", constraint: "scope_snapshot_source_draft_fkey"
    });
    await assert.rejects(f.database.query("insert into app.scope_snapshot(id,project_id,source_draft_id,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,payload,content_hash,review_hash,created_by,created_at) select gen_random_uuid(),project_id,source_draft_id,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,jsonb_set(payload,'{policySnapshot,approvalPolicyVersion}','99'::jsonb),content_hash,review_hash,created_by,created_at from app.scope_snapshot where id=$1", [frozen.snapshotId]), {
      code: "23514", constraint: "scope_snapshot_payload_binding"
    });
  });
});
test("an absent approver and invalid candidate cannot reserve the open slot; policy UUID casing is not an effective change", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input, actorId, fixture } = await prepared(f), before = await getProjectStatus(owner, projectId);
    await updateApprovalPolicy(owner, projectId, {
      key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: actorId.toUpperCase()
    });
    assert.deepEqual(await getProjectStatus(owner, projectId), before);
    fixture.draft.document.requirements[ids.req].confirmation = null;
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, fixture.draft.document]);
    assert.equal((await previewReview(owner, projectId, draftId, input)).check.valid, false);
    await assert.rejects(freezeReview(owner, projectId, draftId, input, randomUUID()), refused("CANDIDATE_INVALID"));
    await updateApprovalPolicy(owner, projectId, {
      key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: null
    });
    await assert.rejects(previewReview(owner, projectId, draftId, {
      ...input, expectedApprovalPolicyVersion: 3
    }), refused("REVIEW_POLICY_CHANGED"));
    assert.equal((await counts(f.database, projectId)).snapshots, 0);
  });
});
test("history pages equal timestamps using stable IDs, rejects hostile cursors and keeps scoped filters", {
  skip: !canRun
}, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input } = await prepared(f), frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    await withdrawReview(owner, projectId, frozen.reviewId, {
      expectedReviewVersion: 1, reason: "History"
    }, randomUUID());
    for (let index = 0; index < 50; index++) {
      const snapshot = randomUUID(), review = randomUUID();
      await f.database.query("begin");
      try {
        await f.database.query("insert into app.scope_snapshot select $2::uuid,project_id,source_draft_id,parent_snapshot_id,captured_document_revision,captured_layout_revision,designated_approver_id,approval_policy_version,payload,content_hash,review_hash,created_by,created_at from app.scope_snapshot where id=$1", [frozen.snapshotId, snapshot]);
        await f.database.query("insert into app.review_request(id,project_id,candidate_snapshot_id,source_draft_id,parent_snapshot_id,designated_approver_id,approval_policy_version,state,version,last_event_sequence,created_by,created_at) select $2::uuid,project_id,$3::uuid,source_draft_id,parent_snapshot_id,designated_approver_id,approval_policy_version,'OPEN',1,1,created_by,created_at from app.review_request where id=$1", [frozen.reviewId, review, snapshot]);
        await f.database.query("update app.review_request set state='WITHDRAWN',version=2,last_event_sequence=2,closed_reason='History' where id=$1", [review]);
        await f.database.query("commit");
      }
      catch (error) {
        await f.database.query("rollback");
        throw error;
      }
    }
    const page = await listReviews(owner, projectId, {
      state: "WITHDRAWN"
    });
    assert.equal(page.items.length, 50);
    assert.ok(page.nextCursor);
    const second = await listReviews(owner, projectId, {
      cursor: page.nextCursor!, state: "WITHDRAWN"
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...page.items, ...second.items].map(item => item.reviewId)).size, 51);
    assert.equal((await listReviews(owner, projectId, {
      state: "OPEN"
    })).items.length, 0);
    for (const options of [{
        cursor: "!"
      }, {
        cursor: "x".repeat(257)
      }, {
        state: "unknown"
      }])
      await assert.rejects(listReviews(owner, projectId, options), refused("INVALID_INPUT"));
  });
});

for (const operation of ["freeze", "withdraw"] as const) {
  test(`review ${operation} preserves exact-key recovery for accepted uppercase route UUIDs`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, draftId, input } = await prepared(f);
      const key = randomUUID();
      if (operation === "freeze") {
        const result = await freezeReview(owner, projectId.toUpperCase(), draftId.toUpperCase(), input, key);
        assert.equal(result.draftId, draftId);
        assert.deepEqual(await freezeReview(owner, projectId.toUpperCase(), draftId.toUpperCase(), input, key), { ...result, replayed: true });
      } else {
        const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
        const reason = { expectedReviewVersion: 1, reason: "Withdraw inspected candidate" };
        const result = await withdrawReview(owner, projectId.toUpperCase(), frozen.reviewId.toUpperCase(), reason, key);
        assert.deepEqual(await withdrawReview(owner, projectId.toUpperCase(), frozen.reviewId.toUpperCase(), reason, key), { ...result, replayed: true });
      }
    });
  });
}

test("review decisions enforce same-project immutable attribution, hashes and bounded comments", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, actorId, input } = await prepared(f);
    const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    const foreignProjectId = await f.project(owner);
    const other = await f.user(), otherActorId = await f.profileId(other);
    const insert = (changes: { projectId?: string; reviewId?: string; actorId?: string; decision?: string; comment?: string | null; reviewedHash?: string } = {}) => f.database.query(
      "insert into app.review_decision(id,project_id,review_id,actor_id,decision,comment,reviewed_hash,created_at) values($1,$2,$3,$4,$5,$6,$7,current_timestamp) returning id",
      [randomUUID(), changes.projectId ?? projectId, changes.reviewId ?? frozen.reviewId, changes.actorId ?? actorId, changes.decision ?? "REJECT", Object.hasOwn(changes, "comment") ? changes.comment : "Reason", changes.reviewedHash ?? frozen.reviewHash],
    );
    await assert.rejects(insert({ projectId: foreignProjectId }), { code: "23503", constraint: "review_decision_review_fkey" });
    await assert.rejects(insert({ actorId: otherActorId }), { code: "23514", constraint: "review_decision_binding" });
    await assert.rejects(insert({ reviewedHash: "a".repeat(64) === frozen.reviewHash ? "b".repeat(64) : "a".repeat(64) }), { code: "23514", constraint: "review_decision_binding" });
    await assert.rejects(insert({ reviewId: randomUUID(), reviewedHash: "G".repeat(64) }), { code: "23514", constraint: "review_decision_hash" });
    for (const comment of [null, "", " \n\t", "\u00a0\u2003\ufeff", "😀".repeat(4001)])
      await assert.rejects(insert({ comment }), { code: "23514", constraint: "review_decision_comment" });
    // A deferred FK must not permit forged attribution by inserting the decision before its review.
    const { rows: [original] } = await f.database.query("select * from app.review_request where id=$1", [frozen.reviewId]);
    await f.database.query("begin");
    try {
      await f.database.query("delete from app.review_request where id=$1", [frozen.reviewId]);
      await insert({ actorId: otherActorId });
      await f.database.query("insert into app.review_request select (jsonb_populate_record(null::app.review_request,$1::jsonb)).*", [JSON.stringify(original)]);
      await assert.rejects(f.database.query("set constraints all immediate"), { code: "23514", constraint: "review_decision_binding" });
    } finally { await f.database.query("rollback"); }
    for (const [name, role] of [["Captured", null], [null, "OWNER"], ["Captured", "VIEWER"], ["", "OWNER"], ["x".repeat(121), "EDITOR"]])
      await assert.rejects(f.database.query("insert into app.review_decision(id,project_id,review_id,actor_id,actor_display_name,actor_role,decision,comment,reviewed_hash,created_at) values($1,$2,$3,$4,$5,$6,'REJECT','Reason',$7,current_timestamp)", [randomUUID(), projectId, frozen.reviewId, actorId, name, role, frozen.reviewHash]), { code: "23514", constraint: "review_decision_actor_attribution" });
    const { rows: [row] } = await insert({ comment: "😀".repeat(4000) });
    assert.deepEqual((await f.database.query("select actor_display_name,actor_role from app.review_decision where id=$1", [row.id])).rows[0], { actor_display_name: null, actor_role: null });
    await assert.rejects(insert(), { code: "23505", constraint: "review_decision_review_id_key" });
    await assert.rejects(f.database.query("update app.review_decision set comment=comment where id=$1", [row.id]), { code: "23514", constraint: "review_decision_immutable" });
    await assert.rejects(f.database.query("delete from app.user_profile where id=$1", [actorId]), { code: "23503" });
    const { rows: [stored] } = await f.database.query("select actor_id,reviewed_hash,comment from app.review_decision where id=$1", [row.id]);
    assert.deepEqual(stored, { actor_id: actorId, reviewed_hash: frozen.reviewHash, comment: "😀".repeat(4000) });
  });
});

test("web runtime can insert each exact decision before terminal closure and publish only required columns", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const runtime = new Client({ connectionString: process.env.DATABASE_URL! });
    await runtime.connect();
    try {
      await runtime.query("set role app_web");
      for (const [decision, state] of [["APPROVE", "APPROVED"], ["REQUEST_CHANGES", "CHANGES_REQUESTED"], ["REJECT", "REJECTED"]]) {
        const { owner, projectId, draftId, actorId, input } = await prepared(f);
        const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
        const approval = decision === "APPROVE";
        const close = () => runtime.query("update app.review_request set state=$2,version=version+1,last_event_sequence=last_event_sequence+1,closed_reason=$3,publication_sequence=$4,published_at=$5 where id=$1", [frozen.reviewId, state, approval ? null : "Reason", approval ? 1 : null, approval ? new Date() : null]);
        await assert.rejects(close(), { code: "23514", constraint: "review_request_decision_binding" });
        await runtime.query("begin");
        try {
          await runtime.query("insert into app.review_decision(id,project_id,review_id,actor_id,decision,comment,reviewed_hash,created_at) values($1,$2,$3,$4,$5,$6,$7,current_timestamp)", [randomUUID(), projectId, frozen.reviewId, actorId, decision, approval ? "" : "Reason", frozen.reviewHash]);
          await close();
          if (approval) {
            await runtime.query("update app.project set approved_snapshot_id=$2,baseline_sequence=1 where id=$1", [projectId, frozen.snapshotId]);
            await runtime.query("update app.scope_draft set base_snapshot_id=$2 where id=$1", [draftId, frozen.snapshotId]);
          }
          await runtime.query("commit");
        } catch (error) { await runtime.query("rollback"); throw error; }
        const { rows: [stored] } = await f.database.query("select state::text,version,publication_sequence from app.review_request where id=$1", [frozen.reviewId]);
        assert.deepEqual(stored, { state, version: 2, publication_sequence: approval ? "1" : null });
        await assert.rejects(runtime.query("update app.review_request set state='OPEN' where id=$1", [frozen.reviewId]), { code: "23514", constraint: "review_request_terminal_state" });
      }
    } finally { await runtime.end(); }
  });
});


test("approval publishes the frozen candidate and preserves every newer draft field", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, input, actorId } = await prepared(f, true);
    const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    await f.database.query("update app.scope_draft set document_revision=2,document_json=jsonb_set(document_json,'{projectGoal}','\"Newer saved goal\"'::jsonb) where id=$1", [draftId]);
    await savePositions(owner, projectId, draftId, { key: randomUUID(), mode: "MOVE_NODES", flowId: ids.flow, items: [{ nodeId: ids.node, expectedPositionVersion: 1, x: 42, y: 24 }] });
    const before = (await f.database.query("select to_jsonb(d)-'base_snapshot_id' as preserved from app.scope_draft d where id=$1", [draftId])).rows[0];
    const counters = await counts(f.database, projectId), status = await getProjectStatus(owner, projectId), key = randomUUID();
    assert.equal(typeof reviewWrites.decideReview, "function", "the exact decision writer must exist");
    const decision = { decision: "APPROVE", expectedReviewVersion: frozen.reviewVersion, expectedReviewHash: frozen.reviewHash };
    const result = await reviewWrites.decideReview(owner, projectId.toUpperCase(), frozen.reviewId.toUpperCase(), decision, key);
    assert.equal(result.state, "APPROVED");
    assert.equal(result.reviewVersion, 2);
    assert.equal(result.approvedSnapshotId, frozen.snapshotId);
    assert.equal(result.baselineSequence, 1);
    assert.equal(result.publicationSequence, 1);
    assert.ok(result.publishedAt);
    assert.equal(result.documentRevision, 2);
    assert.equal(result.layoutRevision, 2);
    assert.equal(result.draftId, draftId);
    assert.equal(result.eventSequence, status.eventSequence + 1);
    assert.equal(result.replayed, false);
    assert.deepEqual((await f.database.query("select to_jsonb(d)-'base_snapshot_id' as preserved from app.scope_draft d where id=$1", [draftId])).rows[0], before);
    assert.equal((await f.database.query("select base_snapshot_id from app.scope_draft where id=$1", [draftId])).rows[0].base_snapshot_id, frozen.snapshotId);
    const detail = await readReview(owner, projectId, frozen.reviewId);
    assert.equal(detail.snapshot.documentJson.projectGoal, "");
    assert.deepEqual(detail.draftChanges, { replaced: false, contentChanged: true, layoutChanged: true });
    assert.equal(detail.decision?.id, result.decisionId);
    assert.equal(detail.decision?.actorId, actorId);
    assert.equal(detail.decision?.reviewedHash, frozen.reviewHash);
    assert.equal(detail.review.publicationSequence, 1);
    const after = await counts(f.database, projectId);
    assert.deepEqual(after, { ...counters, events: counters.events + 1, receipts: counters.receipts + 1 });
    assert.equal((await getProjectStatus(owner, projectId)).reviewsRevision, result.eventSequence);
    assert.deepEqual(await reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key), { ...result, replayed: true });
    assert.deepEqual(await counts(f.database, projectId), after);
  });
});

async function readyDecision(f: Fixture, role: "OWNER" | "EDITOR" | "REVIEWER" = "OWNER") {
  const setup = await prepared(f);
  let approver = setup.owner;
  if (role !== "OWNER") {
    approver = await f.user();
    await f.join(setup.owner, setup.projectId, approver, role);
    await updateApprovalPolicy(setup.owner, setup.projectId, { key: randomUUID(), expectedApprovalPolicyVersion: 2, designatedApproverId: await f.profileId(approver) });
    setup.input.expectedApprovalPolicyVersion = 3;
  }
  const frozen = await freezeReview(setup.owner, setup.projectId, setup.draftId, setup.input, randomUUID());
  return { ...setup, approver, frozen, decision: { decision: "APPROVE" as const, expectedReviewVersion: frozen.reviewVersion, expectedReviewHash: frozen.reviewHash } };
}
async function decisionState(f: Fixture, projectId: string) {
  return (await f.database.query(`select to_jsonb(p) project,
    (select jsonb_agg(to_jsonb(d) order by id) from app.scope_draft d where project_id=p.id) drafts,
    (select jsonb_agg(to_jsonb(r) order by id) from app.review_request r where project_id=p.id) reviews,
    (select count(*)::int from app.review_decision where project_id=p.id) decisions,
    (select count(*)::int from app.audit_event where project_id=p.id) events,
    (select count(*)::int from app.mutation_receipt where scope_id=p.id) receipts
    from app.project p where id=$1`, [projectId])).rows[0];
}
for (const [kind, state] of [["REQUEST_CHANGES", "CHANGES_REQUESTED"], ["REJECT", "REJECTED"]] as const)
  test(`decision ${kind} saves bounded human reason without publishing`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { approver, projectId, draftId, frozen, decision } = await readyDecision(f, "REVIEWER"), before = await decisionState(f, projectId);
      const key = randomUUID(), reason = "😀".repeat(4000);
      const result = await reviewWrites.decideReview(approver, projectId, frozen.reviewId, { ...decision, decision: kind, reason }, key);
      assert.equal(result.state, state);
      assert.equal(result.publicationSequence, null);
      assert.equal(result.publishedAt, null);
      assert.equal(result.approvedSnapshotId, null);
      assert.equal(result.baselineSequence, 0);
      const after = await decisionState(f, projectId);
      assert.deepEqual(after.drafts, before.drafts);
      assert.equal(after.project.current_draft_id, draftId);
      assert.equal(after.project.approved_snapshot_id, null);
      assert.equal(after.project.baseline_sequence, 0);
      assert.equal(after.events, before.events + 1);
      assert.equal(after.receipts, before.receipts + 1);
      assert.equal(after.decisions, 1);
      const detail = await readReview(approver, projectId, frozen.reviewId);
      assert.equal(detail.review.state, state);
      assert.equal(detail.review.reason, reason);
      assert.equal(detail.decision?.comment, reason);
      assert.equal(detail.decision?.decision, kind);
      assert.deepEqual(await reviewWrites.decideReview(approver, projectId, frozen.reviewId, { ...decision, decision: kind, reason }, key), { ...result, replayed: true });
    });
  });
for (const role of ["OWNER", "EDITOR", "REVIEWER"] as const)
  test(`decision accepts only exact captured/current designated ${role}`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, approver, projectId, frozen, decision } = await readyDecision(f, role);
      const other = await f.user(), viewer = await f.user(), stranger = await f.user();
      await f.join(owner, projectId, other, "EDITOR");
      await f.join(owner, projectId, viewer, "VIEWER");
      const before = await decisionState(f, projectId);
      for (const actor of [other, viewer, ...(role === "OWNER" ? [] : [owner])])
        await assert.rejects(reviewWrites.decideReview(actor, projectId, frozen.reviewId, decision, randomUUID()), refused("FORBIDDEN"));
      await assert.rejects(reviewWrites.decideReview(stranger, projectId, frozen.reviewId, decision, randomUUID()), refused("NOT_FOUND"));
      const foreign = await f.project(owner);
      await assert.rejects(reviewWrites.decideReview(owner, foreign, frozen.reviewId, decision, randomUUID()), refused("NOT_FOUND"));
      assert.deepEqual(await decisionState(f, projectId), before);
      assert.equal((await reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, randomUUID())).state, "APPROVED");
    });
  });
test("decision strict input and stale inspected version/hash leave every effect unchanged", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f), before = await decisionState(f, projectId);
    for (const bad of [ { ...decision, actorId: randomUUID() }, { ...decision, decision: "WITHDRAW" }, ...[undefined, "", " \n", "😀".repeat(4001)].map(reason => ({ ...decision, decision: "REJECT", reason })) ])
      await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, bad, randomUUID()), refused("INVALID_INPUT"));
    await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, "bad key"), refused("INVALID_INPUT"));
    await assert.rejects(reviewWrites.decideReview(owner, "bad id", frozen.reviewId, decision, randomUUID()), refused("NOT_FOUND"));
    for (const bad of [{ ...decision, expectedReviewVersion: 2 }, { ...decision, expectedReviewHash: "0".repeat(64) }])
      await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, bad, randomUUID()), refused("CONFLICT"));
    assert.deepEqual(await decisionState(f, projectId), before);
  });
});
for (const change of ["policy", "captured actor", "parent", "archive", "replaced"] as const)
  test(`decision refuses changed ${change} without partial publication`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, draftId, frozen, decision } = await readyDecision(f);
      let actor = owner, code = "CONFLICT";
      if (change === "policy") { await f.database.query("update app.project set approval_policy_version=approval_policy_version+1 where id=$1", [projectId]); code = "REVIEW_POLICY_CHANGED"; }
      if (change === "captured actor") {
        actor = await f.user(); await f.join(owner, projectId, actor, "REVIEWER");
        await f.database.query("update app.project set designated_approver_id=$2 where id=$1", [projectId, await f.profileId(actor)]); code = "REVIEW_POLICY_CHANGED";
      }
      if (change === "parent") { await f.database.query("update app.project set approved_snapshot_id=$2,baseline_sequence=1 where id=$1", [projectId, frozen.snapshotId]); code = "BASELINE_CHANGED"; }
      if (change === "archive") await archiveProject(owner, projectId, { key: randomUUID(), expectedProjectVersion: 1, reason: "Close" });
      if (change === "replaced") {
        const replacement = randomUUID();
        await f.database.query("begin");
        await f.database.query("update app.scope_draft set status='ARCHIVED' where id=$1", [draftId]);
        await f.database.query("insert into app.scope_draft(id,project_id,created_by,document_json,layout_json) select $2,project_id,created_by,document_json,layout_json from app.scope_draft where id=$1", [draftId, replacement]);
        await f.database.query("update app.project set current_draft_id=$2 where id=$1", [projectId, replacement]); code = "DRAFT_REPLACED";
        await f.database.query("commit");
      }
      const before = await decisionState(f, projectId);
      await assert.rejects(reviewWrites.decideReview(actor, projectId, frozen.reviewId, decision, randomUUID()), refused(code));
      assert.deepEqual(await decisionState(f, projectId), before);
    });
  });
test("decision exact receipt replays after downgrade/archive, rejects changed input and denies removal", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, approver, projectId, frozen, decision } = await readyDecision(f, "REVIEWER"), key = randomUUID(), actorId = await f.profileId(approver);
    const result = await reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, key);
    await changeProjectMember(owner, projectId, actorId, { key: randomUUID(), expectedMemberVersion: 1, role: "VIEWER" });
    assert.deepEqual(await reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, key), { ...result, replayed: true });
    await assert.rejects(reviewWrites.decideReview(approver, projectId, frozen.reviewId, { ...decision, reason: "Different input" }, key), refused("KEY_REUSED"));
    await archiveProject(owner, projectId, { key: randomUUID(), expectedProjectVersion: 1, reason: "Close" });
    assert.deepEqual(await reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, key), { ...result, replayed: true });
    await removeProjectMember(owner, projectId, actorId, { key: randomUUID(), expectedMemberVersion: 2 });
    const before = await decisionState(f, projectId);
    await assert.rejects(reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, key), refused("NOT_FOUND"));
    assert.deepEqual(await decisionState(f, projectId), before);
  });
});
test("terminal decision remains single after receipt expiry and with every new key", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f), key = randomUUID();
    await reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key);
    await f.database.query("update app.mutation_receipt set expires_at=current_timestamp-interval '1 second' where scope_id=$1 and key=$2", [projectId, key]);
    const before = await decisionState(f, projectId);
    for (const nextKey of [key, randomUUID()]) await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, nextKey), refused("CONFLICT"));
    assert.deepEqual(await decisionState(f, projectId), before);
  });
});
for (const sameKey of [true, false])
  test(`held decision barrier serializes ${sameKey ? "identical" : "competing"} keys into one immutable effect`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, frozen, decision } = await readyDecision(f), key = randomUUID(), before = await decisionState(f, projectId);
      await barrier(f, projectId, async (holder, pid) => {
        const first = reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key);
        await waitForWaiters(f.database, pid, 1);
        const second = reviewWrites.decideReview(owner, projectId, frozen.reviewId, sameKey ? decision : { ...decision, decision: "REJECT", reason: "Competing decision" }, sameKey ? key : randomUUID());
        await waitForWaiters(f.database, pid, 2);
        await holder.query("commit");
        const [one, two] = await Promise.allSettled([first, second]);
        assert.equal(one.status, "fulfilled");
        if (sameKey) {
          assert.equal(two.status, "fulfilled");
          if (one.status === "fulfilled" && two.status === "fulfilled") assert.deepEqual(two.value, { ...one.value, replayed: true });
        } else {
          assert.equal(two.status, "rejected");
          if (two.status === "rejected") assert.ok(refused("CONFLICT")(two.reason));
        }
        const after = await decisionState(f, projectId);
        assert.equal(after.decisions, 1);
        assert.equal(after.events, before.events + 1);
        assert.equal(after.receipts, before.receipts + 1);
        assert.equal(after.project.baseline_sequence, 1);
        assert.equal(after.project.reviews_revision, after.project.event_sequence);
      });
    });
  });
for (const change of ["policy", "archive", "downgrade", "remove"] as const)
  for (const first of ["decision", "change"] as const)
    test(`held decision versus ${change}: ${first} obtains project lock first`, { skip: !canRun }, async () => {
      await withFixture(async (f) => {
        const { owner, approver, projectId, frozen, decision } = await readyDecision(f, "REVIEWER"), actorId = await f.profileId(approver);
        await barrier(f, projectId, async (holder, pid) => {
          const decide = () => reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, randomUUID());
          const edit = () => change === "policy" ? updateApprovalPolicy(owner, projectId, { key: randomUUID(), expectedApprovalPolicyVersion: 3, designatedApproverId: null })
            : change === "archive" ? archiveProject(owner, projectId, { key: randomUUID(), expectedProjectVersion: 1, reason: "Close" })
            : change === "downgrade" ? changeProjectMember(owner, projectId, actorId, { key: randomUUID(), expectedMemberVersion: 1, role: "VIEWER" })
            : removeProjectMember(owner, projectId, actorId, { key: randomUUID(), expectedMemberVersion: 1 });
          const a = first === "decision" ? decide() : edit();
          await waitForWaiters(f.database, pid, 1);
          const b = first === "decision" ? edit() : decide();
          await waitForWaiters(f.database, pid, 2);
          await holder.query("commit");
          const [one, two] = await Promise.allSettled([a, b]);
          assert.equal(one.status, "fulfilled");
          if (first === "decision") assert.equal(two.status, "fulfilled");
          else {
            assert.equal(two.status, "rejected");
            if (two.status === "rejected") assert.ok(refused(change === "archive" ? "CONFLICT" : change === "remove" ? "NOT_FOUND" : "FORBIDDEN")(two.reason));
          }
          const after = await decisionState(f, projectId);
          assert.equal(after.decisions, first === "decision" ? 1 : 0);
          assert.equal(after.project.baseline_sequence, first === "decision" ? 1 : 0);
          assert.equal(after.project.approved_snapshot_id, first === "decision" ? frozen.snapshotId : null);
          assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.state, first === "decision" ? "APPROVED" : "SUPERSEDED");
          const audit = (await f.database.query("select action from app.audit_event where project_id=$1 and action='REVIEW_APPROVED'", [projectId])).rows;
          assert.equal(audit.length, first === "decision" ? 1 : 0);
        });
      });
    });

for (const boundary of [2147483647, Number.MAX_SAFE_INTEGER - 1])
  test(`approval baseline counter advances above integer revision bound from ${boundary}`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const setup = await readyDecision(f);
      await reviewWrites.decideReview(setup.owner, setup.projectId, setup.frozen.reviewId, setup.decision, randomUUID());
      await f.database.query("update app.project set baseline_sequence=$2 where id=$1", [setup.projectId, boundary]);
      setup.fixture.draft.document.requirements[ids.req].statement = "A new included agreement";
      await f.database.query("update app.scope_draft set document_json=$2,document_revision=2 where id=$1", [setup.draftId, setup.fixture.draft.document]);
      const frozen = await freezeReview(setup.owner, setup.projectId, setup.draftId, { ...setup.input, expectedDocumentRevision: 2, expectedParentSnapshotId: setup.frozen.snapshotId }, randomUUID());
      const result = await reviewWrites.decideReview(setup.owner, setup.projectId, frozen.reviewId, { ...setup.decision, expectedReviewHash: frozen.reviewHash }, randomUUID());
      assert.equal(result.baselineSequence, boundary + 1);
      assert.equal(result.publicationSequence, boundary + 1);
      assert.equal((await getProjectStatus(setup.owner, setup.projectId)).baselineSequence, boundary + 1);
    });
  });
for (const counter of ["baseline", "review", "event"] as const)
  test(`decision ${counter} exhaustion rolls back every effect atomically`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, frozen, decision } = await readyDecision(f);
      if (counter === "baseline") await f.database.query("update app.project set baseline_sequence=$2 where id=$1", [projectId, Number.MAX_SAFE_INTEGER]);
      if (counter === "event") await f.database.query("update app.project set event_sequence=$2 where id=$1", [projectId, Number.MAX_SAFE_INTEGER]);
      if (counter === "review") {
        await f.database.query("begin");
        try {
          await f.database.query("alter table app.review_request disable trigger review_request_binding");
          await f.database.query("alter table app.review_request disable trigger review_request_candidate_binding_check");
          await f.database.query("update app.review_request set version=2147483647 where id=$1", [frozen.reviewId]);
          await f.database.query("set constraints all immediate");
          await f.database.query("alter table app.review_request enable trigger review_request_binding");
          await f.database.query("alter table app.review_request enable trigger review_request_candidate_binding_check");
          await f.database.query("commit");
        } catch (error) { await f.database.query("rollback"); throw error; }
      }
      const before = await decisionState(f, projectId);
      await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, { ...decision, expectedReviewVersion: counter === "review" ? 2147483647 : 1 }, randomUUID()), refused("VERSION_EXHAUSTED"));
      assert.deepEqual(await decisionState(f, projectId), before);
    });
  });
for (const point of ["audit_event", "review_request", "mutation_receipt"] as const)
  test(`decision ${point} failure rolls back publication and then the identical request succeeds`, { skip: !canRun }, async () => {
    await withFixture(async (f) => {
      const { owner, projectId, frozen, decision } = await readyDecision(f), before = await decisionState(f, projectId), key = randomUUID(), name = `test_decision_${randomUUID().replaceAll("-", "")}`;
      const match = point === "mutation_receipt" ? `NEW.scope_id='${projectId}'::uuid AND NEW.operation='DECIDE_REVIEW_V1'`
        : point === "audit_event" ? `NEW.project_id='${projectId}'::uuid AND NEW.action='REVIEW_APPROVED'`
        : `NEW.project_id='${projectId}'::uuid AND NEW.state='APPROVED'`;
      await f.database.query("begin");
      try {
        await f.database.query("lock table app.project in exclusive mode");
        await f.database.query(`create function app.${name}() returns trigger language plpgsql as $$ begin if ${match} then raise exception 'test decision failure' using errcode='23514'; end if; return NEW; end; $$; create trigger ${name} before ${point === "review_request" ? "update" : "insert"} on app.${point} for each row execute function app.${name}()`);
        await f.database.query("commit");
      } catch (error) { await f.database.query("rollback"); throw error; }
      try {
        await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key), refused("UNAVAILABLE"));
        assert.deepEqual(await decisionState(f, projectId), before);
      } finally {
        await f.database.query("begin");
        try {
          await f.database.query("lock table app.project in exclusive mode");
          await f.database.query(`drop trigger ${name} on app.${point};drop function app.${name}()`);
          await f.database.query("commit");
        } catch (error) { await f.database.query("rollback"); throw error; }
      }
      const result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key), after = await decisionState(f, projectId);
      assert.equal(result.state, "APPROVED");
      assert.equal(after.decisions, 1);
      assert.equal(after.events, before.events + 1);
      assert.equal(after.receipts, before.receipts + 1);
    });
  });
test("decision verifies immutable candidate hash and payload before any terminal effect", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f);
    const { rows: [original] } = await f.database.query("select payload from app.scope_snapshot where id=$1", [frozen.snapshotId]);
    for (const corruption of ["hash", "payload"] as const) {
      await f.database.query("begin");
      try {
        await f.database.query("alter table app.scope_snapshot disable trigger scope_snapshot_immutable");
        await f.database.query("update app.scope_snapshot set payload=$2,review_hash=$3 where id=$1", [frozen.snapshotId, corruption === "payload" ? { ...original.payload, documentJson: { ...original.payload.documentJson, projectGoal: "Forged bytes" } } : original.payload, corruption === "hash" ? "0".repeat(64) : frozen.reviewHash]);
        await f.database.query("alter table app.scope_snapshot enable trigger scope_snapshot_immutable");
        await f.database.query("commit");
      } catch (error) { await f.database.query("rollback"); throw error; }
      const before = await decisionState(f, projectId);
      await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, randomUUID()), refused("UNAVAILABLE"));
      assert.deepEqual(await decisionState(f, projectId), before);
    }
  });
});
test("held source draft then review lock prevents decision from using metadata read before a waiter", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, draftId, frozen, decision } = await readyDecision(f);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect(); await holder.query("begin");
    try {
      await holder.query("select id from app.scope_draft where id=$1 for update", [draftId]);
      await holder.query("select id from app.review_request where id=$1 for update", [frozen.reviewId]);
      const pid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid;
      const pending = reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, randomUUID());
      await waitForWaiters(f.database, pid, 1);
      await holder.query("update app.scope_draft set document_revision=2,layout_revision=2 where id=$1", [draftId]);
      await holder.query("commit");
      const result = await pending;
      assert.equal(result.documentRevision, 2);
      assert.equal(result.layoutRevision, 2);
      assert.equal(result.state, "APPROVED");
    } finally { await holder.query("rollback"); await holder.end(); }
  });
});

test("decision receipt refuses valid-shaped corruption of exact terminal audit binding", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f), key = randomUUID();
    const result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key);
    await f.database.query("update app.mutation_receipt set result=jsonb_set(result,'{eventSequence}',to_jsonb($3::bigint)) where scope_id=$1 and key=$2", [projectId, key, result.eventSequence + 1]);
    const before = await decisionState(f, projectId);
    await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, key), refused("UNAVAILABLE"));
    assert.deepEqual(await decisionState(f, projectId), before);
  });
});
test("negative decision receipt refuses a fabricated baseline instead of replaying unbound result", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f), key = randomUUID(), input = { ...decision, decision: "REJECT", reason: "Review again" };
    await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key);
    await f.database.query("update app.mutation_receipt set result=result || jsonb_build_object('approvedSnapshotId',$3::text,'baselineSequence',1) where scope_id=$1 and key=$2", [projectId, key, frozen.snapshotId]);
    const before = await decisionState(f, projectId);
    await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key), refused("UNAVAILABLE"));
    assert.deepEqual(await decisionState(f, projectId), before);
  });
});
test("old decision receipt returns its saved baseline and revisions after a later real publication", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const setup = await readyDecision(f), key = randomUUID();
    const result = await reviewWrites.decideReview(setup.owner, setup.projectId, setup.frozen.reviewId, setup.decision, key);
    setup.fixture.draft.document.requirements[ids.req].statement = "A later included agreement";
    await f.database.query("update app.scope_draft set document_json=$2,document_revision=2 where id=$1", [setup.draftId, setup.fixture.draft.document]);
    const frozen = await freezeReview(setup.owner, setup.projectId, setup.draftId, { ...setup.input, expectedDocumentRevision: 2, expectedParentSnapshotId: setup.frozen.snapshotId }, randomUUID());
    const next = await reviewWrites.decideReview(setup.owner, setup.projectId, frozen.reviewId, { ...setup.decision, expectedReviewHash: frozen.reviewHash }, randomUUID());
    assert.equal(next.baselineSequence, 2);
    assert.notEqual(next.approvedSnapshotId, result.approvedSnapshotId);
    assert.deepEqual(await reviewWrites.decideReview(setup.owner, setup.projectId, setup.frozen.reviewId, setup.decision, key), { ...result, replayed: true });
    assert.equal((await readReview(setup.owner, setup.projectId, setup.frozen.reviewId)).decision?.id, result.decisionId);
  });
});
test("review reader validates permanent decision actor, hash and terminal kind against its frozen review", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { owner, projectId, frozen, decision } = await readyDecision(f), other = await f.user(), otherId = await f.profileId(other);
    const result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, decision, randomUUID());
    for (const [actor, hash, kind, comment] of [[otherId, frozen.reviewHash, "APPROVE", null], [await f.profileId(owner), "0".repeat(64), "APPROVE", null], [await f.profileId(owner), frozen.reviewHash, "REJECT", "Forged reason"]]) {
      await f.database.query("begin");
      try {
        await f.database.query("alter table app.review_decision disable trigger review_decision_binding");
        await f.database.query("update app.review_decision set actor_id=$2,reviewed_hash=$3,decision=$4,comment=$5 where id=$1", [result.decisionId, actor, hash, kind, comment]);
        await f.database.query("alter table app.review_decision enable trigger review_decision_binding");
        await f.database.query("commit");
      } catch (error) { await f.database.query("rollback"); throw error; }
      await assert.rejects(readReview(owner, projectId, frozen.reviewId), refused("UNAVAILABLE"));
    }
  });
});
test("held trusted actor lock refuses a mapping removed after profile resolution", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const { approver, projectId, frozen, decision } = await readyDecision(f, "REVIEWER"), actorId = await f.profileId(approver), before = await decisionState(f, projectId);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect(); await holder.query("begin");
    try {
      await holder.query("select id from app.user_profile where id=$1 for update", [actorId]);
      const pid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid;
      const pending = reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, randomUUID());
      await waitForWaiters(f.database, pid, 1);
      await holder.query("update app.user_profile set auth_user_id=null where id=$1", [actorId]);
      await holder.query("commit");
      await assert.rejects(pending, refused("FORBIDDEN"));
      assert.deepEqual(await decisionState(f, projectId), before);
    } finally {
      await holder.query("rollback"); await holder.end();
      await f.database.query("update app.user_profile set auth_user_id=$2 where id=$1", [actorId, approver.authUserId]);
    }
  });
});

test("negative decision preserves an existing baseline and replays it after a newer publication", { skip: !canRun }, async () => {
  await withFixture(async (f) => {
    const setup = await readyDecision(f);
    const first = await reviewWrites.decideReview(setup.owner, setup.projectId, setup.frozen.reviewId, setup.decision, randomUUID());
    setup.fixture.draft.document.requirements[ids.req].statement = "Included work awaiting agreement";
    await f.database.query("update app.scope_draft set document_json=$2,document_revision=2 where id=$1", [setup.draftId, setup.fixture.draft.document]);
    const guards = { ...setup.input, expectedDocumentRevision: 2, expectedParentSnapshotId: first.approvedSnapshotId };
    const rejected = await freezeReview(setup.owner, setup.projectId, setup.draftId, guards, randomUUID());
    const input = { decision: "REQUEST_CHANGES", reason: "Clarify the included work", expectedReviewVersion: 1, expectedReviewHash: rejected.reviewHash }, key = randomUUID();
    const result = await reviewWrites.decideReview(setup.owner, setup.projectId, rejected.reviewId, input, key);
    assert.equal(result.approvedSnapshotId, first.approvedSnapshotId);
    assert.equal(result.baselineSequence, 1);
    assert.equal(result.publicationSequence, null);
    assert.equal((await f.database.query("select base_snapshot_id from app.scope_draft where id=$1", [setup.draftId])).rows[0].base_snapshot_id, first.approvedSnapshotId);
    const next = await freezeReview(setup.owner, setup.projectId, setup.draftId, guards, randomUUID());
    const approved = await reviewWrites.decideReview(setup.owner, setup.projectId, next.reviewId, { ...setup.decision, expectedReviewHash: next.reviewHash }, randomUUID());
    assert.equal(approved.baselineSequence, 2);
    assert.deepEqual(await reviewWrites.decideReview(setup.owner, setup.projectId, rejected.reviewId, input, key), { ...result, replayed: true });
    await f.database.query("update app.mutation_receipt set result=jsonb_set(result,'{baselineSequence}',to_jsonb($3::bigint)) where scope_id=$1 and key=$2", [setup.projectId, key, approved.baselineSequence]);
    const before = await decisionState(f, setup.projectId);
    await assert.rejects(reviewWrites.decideReview(setup.owner, setup.projectId, rejected.reviewId, input, key), refused("UNAVAILABLE"));
    assert.deepEqual(await decisionState(f, setup.projectId), before);
    await f.database.query("update app.mutation_receipt set result=jsonb_set(result,'{baselineSequence}',to_jsonb($3::bigint)) where scope_id=$1 and key=$2", [setup.projectId, key, result.baselineSequence]);
    assert.deepEqual(await reviewWrites.decideReview(setup.owner, setup.projectId, rejected.reviewId, input, key), { ...result, replayed: true });
  });
});

for (const [label, reason] of [["omitted", undefined], ["empty", ""], ["whitespace", " \n\t\u00a0\u2003\ufeff"], ["nonblank exact", " Preserve this comment \n"]] as const) {
  test(`approval optional ${label} comment stores safely and replays the exact original request`, { skip: !canRun }, async () => {
    await withFixture(async f => {
      const { owner, projectId, frozen, decision } = await readyDecision(f);
      const input = { ...decision, ...(reason === undefined ? {} : { reason }) }, key = randomUUID();
      const result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key);
      const stored = await readReview(owner, projectId, frozen.reviewId);
      const comment = reason?.trim() ? reason : null;
      assert.equal(result.state, "APPROVED");
      assert.equal(stored.decision?.comment, comment); assert.equal(stored.review.reason, comment);
      const after = await decisionState(f, projectId);
      assert.equal(after.decisions, 1);
      assert.deepEqual(await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key), { ...result, replayed: true });
      assert.deepEqual(await decisionState(f, projectId), after);
      const changed = reason === undefined ? { ...decision, reason: "" } : { ...decision };
      await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, changed, key), refused("KEY_REUSED"));
    });
  });
}


test("published snapshot reader conceals unpublished IDs and preserves immutable history with current access", { skip: !canRun }, async () => {
  await withFixture(async f => {
    const reads = await import("../../src/features/reviews/server/read-reviews.ts");
    assert.equal(typeof reads.readSnapshot, "function");
    const setup = await readyDecision(f, "REVIEWER"), { owner, approver, projectId, draftId, frozen, decision } = setup;
    const viewer = await f.user(); await f.join(owner, projectId, viewer, "VIEWER");
    await assert.rejects(reads.readSnapshot(viewer, projectId, frozen.snapshotId), refused("NOT_FOUND"));
    assert.equal((await reads.listSnapshots(viewer, projectId)).items.length, 0);
    const result = await reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, randomUUID());
    const original = await reads.readSnapshot(viewer, projectId, frozen.snapshotId);
    assert.equal(original.publicationSequence, 1); assert.equal(original.publishedAt, result.publishedAt);
    assert.equal(original.decision.actorId, await f.profileId(approver));
    const other = await f.project(owner);
    await assert.rejects(reads.readSnapshot(owner, other, frozen.snapshotId), refused("NOT_FOUND"));
    await f.database.query("update app.user_profile set display_name='Renamed approver' where id=$1", [original.decision.actorId]);
    await removeProjectMember(owner, projectId, original.decision.actorId, {key:randomUUID(),expectedMemberVersion:1});
    await updateProjectSettings(owner, projectId, {key:randomUUID(),expectedSettingsVersion:1,name:"Renamed project"});
    await f.database.query("update app.scope_draft set document_revision=2,layout_revision=2,document_json=jsonb_set(document_json,'{projectGoal}','\"Later goal\"'::jsonb) where id=$1", [draftId]);
    assert.deepEqual(await reads.readSnapshot(viewer, projectId, frozen.snapshotId), original);
    await assert.rejects(reads.readSnapshot(approver, projectId, frozen.snapshotId), refused("NOT_FOUND"));
    await archiveProject(owner, projectId, {key:randomUUID(),expectedProjectVersion:1,reason:"History read"});
    assert.deepEqual(await reads.readSnapshot(viewer, projectId, frozen.snapshotId), original);
    assert.equal((await reads.listSnapshots(viewer, projectId)).items[0].snapshotId, frozen.snapshotId);
  });
});

test("published history is bounded summary SQL with strict project scoped descending pagination", { skip: !canRun }, async context => {
  await withFixture(async f => {
    const reads = await import("../../src/features/reviews/server/read-reviews.ts");
    assert.equal(typeof reads.listSnapshots, "function");
    const {owner,projectId,draftId,input,fixture} = await prepared(f);
    for (let sequence=1;sequence<=51;sequence++) {
      fixture.draft.document.projectGoal = "Baseline " + sequence;
      await f.database.query("update app.scope_draft set document_json=$2,document_revision=$3 where id=$1", [draftId,fixture.draft.document,sequence]);
      const status=await getProjectStatus(owner,projectId);
      const frozen=await freezeReview(owner,projectId,draftId,{...input,expectedDocumentRevision:sequence,expectedParentSnapshotId:status.approvedSnapshotId},randomUUID());
      await reviewWrites.decideReview(owner,projectId,frozen.reviewId,{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:frozen.reviewHash},randomUUID());
    }
    const queries=context.mock.method(Client.prototype,"query");
    try {
      const first=await reads.listSnapshots(owner,projectId.toUpperCase());
      assert.equal(first.items.length,50); assert.ok(first.nextCursor);
      assert.deepEqual(first.items.map(item=>item.publicationSequence),Array.from({length:50},(_,i)=>51-i));
      const sql=queries.mock.calls.map(({arguments:[query]})=>{const q: unknown=query; return typeof q==="string"?q:q&&typeof q==="object"&&"text" in q?String(q.text):"";});
      assert.ok(sql.some(q=>/review_request/.test(q)));
      assert.ok(sql.every(q=>!/(\bpayload\b|document_json|layout_json|source_version)/.test(q)),"list selects summary metadata only");
      const second=await reads.listSnapshots(owner,projectId,{cursor:first.nextCursor!});
      assert.equal(second.items.length,1);assert.equal(second.items[0].publicationSequence,1);assert.equal(second.nextCursor,null);
      assert.equal(new Set([...first.items,...second.items].map(item=>item.snapshotId)).size,51);
      const foreign=await f.project(owner);
      await assert.rejects(reads.listSnapshots(owner,foreign,{cursor:first.nextCursor!}),refused("INVALID_INPUT"));
      for(const cursor of ["!","x".repeat(257), Buffer.from(JSON.stringify({projectId,id:randomUUID(),publicationSequence:0})).toString("base64url"),Buffer.from(JSON.stringify({projectId,id:randomUUID(),publicationSequence:1,extra:true})).toString("base64url")])
        await assert.rejects(reads.listSnapshots(owner,projectId,{cursor}),refused("INVALID_INPUT"));
    } finally {queries.mock.restore();}
  });
});


test("published snapshot keeps captured evidence and exact earlier publication after source correction and later approval", {skip:!canRun},async()=>{
  await withFixture(async f=>{
    const reads=await import("../../src/features/reviews/server/read-reviews.ts");
    const {owner,projectId,draftId,input,fixture}=await prepared(f);
    const source=await createSource(owner,projectId,{title:"Original brief",text:"Original evidence",key:randomUUID()});
    fixture.draft.document.requirements[ids.req].sourceRefs=[{sourceVersionId:source.sourceVersionId,startLine:1,endLine:1,excerpt:"Original evidence"}];
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1",[draftId,fixture.draft.document]);
    const frozen=await freezeReview(owner,projectId,draftId,input,randomUUID());
    await reviewWrites.decideReview(owner,projectId,frozen.reviewId,{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:frozen.reviewHash,reason:"Exact first publication"},randomUUID());
    const original=await reads.readSnapshot(owner,projectId,frozen.snapshotId);
    await correctSource(owner,projectId,source.sourceId,{title:"Corrected brief",text:"Corrected evidence",expectedSourceRecordVersion:1,expectedCurrentVersionId:source.sourceVersionId,key:randomUUID()});
    fixture.draft.document.projectGoal="Second agreed goal";
    await f.database.query("update app.scope_draft set document_json=$2,document_revision=2 where id=$1",[draftId,fixture.draft.document]);
    const next=await freezeReview(owner,projectId,draftId,{...input,expectedDocumentRevision:2,expectedParentSnapshotId:frozen.snapshotId},randomUUID());
    await reviewWrites.decideReview(owner,projectId,next.reviewId,{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:next.reviewHash},randomUUID());
    assert.deepEqual(await reads.readSnapshot(owner,projectId,frozen.snapshotId),original);
    assert.equal(original.snapshot.evidenceManifest[0].text,"Original evidence");
    assert.equal(original.snapshot.evidenceManifest[0].title,"Original brief");
    assert.deepEqual((await reads.listSnapshots(owner,projectId)).items.map(item=>item.publicationSequence),[2,1]);
    const held=f.database;
    await held.query("begin");
    try {
      await held.query("alter table app.review_decision disable trigger review_decision_binding");
      await held.query("update app.review_decision set reviewed_hash=repeat('0',64) where review_id=$1",[frozen.reviewId]);
      await held.query("alter table app.review_decision enable trigger review_decision_binding");
      await held.query("commit");
    }catch(error){await held.query("rollback");throw error;}
    await assert.rejects(reads.readSnapshot(owner,projectId,frozen.snapshotId),refused("UNAVAILABLE"));
  });
});

test("approved Markdown uses exact immutable publication bytes and current membership, including archived readers", { skip: !canRun }, async () => {
  await withFixture(async f => {
    const exporter = await import("../../src/features/exports/server/approved-markdown.ts");
    const { owner, projectId, draftId, input, fixture } = await prepared(f);
    const viewer = await f.user(); await f.join(owner, projectId, viewer, "VIEWER");
    await updateProjectSettings(owner, projectId, { key: randomUUID(), expectedSettingsVersion: 1, name: "NUL.txt" });
    const source = await createSource(owner, projectId, { title: "Old brief", text: "line one\nOld cited text", key: randomUUID() });
    fixture.draft.document.requirements[ids.req].sourceRefs = [{ sourceVersionId: source.sourceVersionId, startLine: 2, endLine: 2, excerpt: "Old cited text" }];
    await f.database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, fixture.draft.document]);
    const frozen = await freezeReview(owner, projectId, draftId, input, randomUUID());
    await assert.rejects(exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId), refused("NOT_FOUND"));
    await reviewWrites.decideReview(owner, projectId, frozen.reviewId, { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash }, randomUUID());
    const original = await exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId);
    assert.ok(original.text.includes("Old cited text")); assert.ok(original.text.includes("lines 2-2")); assert.equal(original.filename, "flow.md");
    const before = await counts(f.database, projectId);
    await updateProjectSettings(owner, projectId, { key: randomUUID(), expectedSettingsVersion: 2, name: "New current name" });
    await correctSource(owner, projectId, source.sourceId, { title: "New brief", text: "Corrected text", expectedSourceRecordVersion: 1, expectedCurrentVersionId: source.sourceVersionId, key: randomUUID() });
    fixture.draft.document.projectGoal = "Newer agreed goal";
    await f.database.query("update app.scope_draft set document_json=$2,document_revision=2 where id=$1", [draftId, fixture.draft.document]);
    const next = await freezeReview(owner, projectId, draftId, { ...input, expectedDocumentRevision: 2, expectedParentSnapshotId: frozen.snapshotId }, randomUUID());
    await reviewWrites.decideReview(owner, projectId, next.reviewId, { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: next.reviewHash }, randomUUID());
    assert.deepEqual(await exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId), original);
    assert.equal((await exporter.exportApprovedMarkdown(owner, projectId, next.snapshotId)).text.includes("Newer agreed goal"), true);
    const after = await counts(f.database, projectId);
    assert.equal(after.snapshots, before.snapshots + 1);
    await archiveProject(owner, projectId, { key: randomUUID(), expectedProjectVersion: 1, reason: "Keep historic export" });
    assert.deepEqual(await exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId), original);
    const unchanged = await counts(f.database, projectId);
    assert.deepEqual(await exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId), original);
    assert.deepEqual(await counts(f.database, projectId), unchanged);
    await removeProjectMember(owner, projectId, await f.profileId(viewer), { key: randomUUID(), expectedMemberVersion: 1 });
    await assert.rejects(exporter.exportApprovedMarkdown(viewer, projectId, frozen.snapshotId), refused("NOT_FOUND"));
    await assert.rejects(exporter.exportApprovedMarkdown(owner, await f.project(owner), frozen.snapshotId), refused("NOT_FOUND"));
  });
});


test("real publication preserves saved A after freeze B and pending meaning returns clean at newer B revisions", { skip: !canRun }, async () => {
  await withFixture(async f => {
    const { owner, projectId, draftId, input } = await prepared(f, true);
    const publish = async (frozen: Awaited<ReturnType<typeof freezeReview>>) => reviewWrites.decideReview(owner, projectId, frozen.reviewId, { decision: "APPROVE", expectedReviewVersion: frozen.reviewVersion, expectedReviewHash: frozen.reviewHash }, randomUUID());
    const first = await freezeReview(owner, projectId, draftId, input, randomUUID()); await publish(first);
    const edit = async (purpose: string, confirm = false) => {
      let saved = (await getProjectBootstrap(owner, projectId)).draft;
      await executeGraphCommand(owner, projectId, draftId, { commandSchemaVersion: 1, command: "UPDATE_FLOW", key: randomUUID(), expectedEntityVersion: saved.document.flows[ids.flow]!.version, payload: { flowId: ids.flow, purpose } });
      if (confirm) { saved = (await getProjectBootstrap(owner, projectId)).draft; await executeGraphCommand(owner, projectId, draftId, { commandSchemaVersion: 1, command: "CONFIRM_FLOW", key: randomUUID(), expectedEntityVersion: saved.document.flows[ids.flow]!.version, payload: { flowId: ids.flow } }); }
    };
    await edit("B meaning", true);
    const beforeFreeze = await getProjectStatus(owner, projectId);
    const second = await freezeReview(owner, projectId, draftId, { ...input, expectedDocumentRevision: beforeFreeze.documentRevision, expectedParentSnapshotId: first.snapshotId }, randomUUID());
    await edit("");
    const before = (await f.database.query("select * from app.scope_draft where id=$1", [draftId])).rows[0];
    await publish(second);
    const after = (await f.database.query("select * from app.scope_draft where id=$1", [draftId])).rows[0];
    assert.deepEqual(after, { ...before, base_snapshot_id: second.snapshotId });
    const { readSnapshot } = await import("../../src/features/reviews/server/read-reviews.ts");
    const baseline = await readSnapshot(owner, projectId, second.snapshotId), saved = (await getProjectBootstrap(owner, projectId)).draft;
    assert.deepEqual(savedPendingWork(saved, baseline, await getProjectStatus(owner, projectId), undefined, true), { kind: "compared", semantic: true, layout: false });
    await edit("B meaning");
    let current = await getProjectBootstrap(owner, projectId);
    assert.ok(current.draft.documentRevision > baseline.snapshot.capturedDocumentRevision);
    assert.deepEqual(savedPendingWork(current.draft, baseline, current.status, undefined, true), { kind: "compared", semantic: false, layout: false });
    await savePositions(owner, projectId, draftId, { key: randomUUID(), mode: "MOVE_NODES", flowId: ids.flow, items: [{ nodeId: ids.node, expectedPositionVersion: 1, x: 42, y: 24 }] });
    current = await getProjectBootstrap(owner, projectId);
    assert.deepEqual(savedPendingWork(current.draft, baseline, current.status, undefined, true), { kind: "compared", semantic: false, layout: true });
  });
});

test("ECMAScript nonblank control reasons save unchanged for all decisions and withdrawal", { skip: !canRun }, async () => {
  await withFixture(async f => {
    for (const reason of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085"]) {
      for (const kind of ["APPROVE", "REQUEST_CHANGES", "REJECT", "WITHDRAW"] as const) {
        const { owner, projectId, frozen, decision } = await readyDecision(f), key = randomUUID();
        if (kind === "WITHDRAW") {
          const input = { expectedReviewVersion: 1, reason };
          const result = await withdrawReview(owner, projectId, frozen.reviewId, input, key);
          assert.deepEqual(await withdrawReview(owner, projectId, frozen.reviewId, input, key), { ...result, replayed: true });
        } else {
          const input = { ...decision, decision: kind, reason };
          const result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key);
          assert.deepEqual(await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key), { ...result, replayed: true });
          assert.equal((await readReview(owner, projectId, frozen.reviewId)).decision?.comment, reason);
        }
        assert.equal((await readReview(owner, projectId, frozen.reviewId)).review.reason, reason);
      }
    }
  });
});

test("decision captures locked current actor name and eligible role immutably", { skip: !canRun }, async () => {
  await withFixture(async f => {
    for (const role of ["OWNER", "EDITOR", "REVIEWER"] as const) {
      const { owner, approver, projectId, frozen, decision } = await readyDecision(f, role);
      const actorId = await f.profileId(approver);
      await f.database.query("update app.user_profile set display_name='Captured actor' where id=$1", [actorId]);
      await reviewWrites.decideReview({ ...approver, displayName: "Stale Auth name" }, projectId, frozen.reviewId, decision, randomUUID());
      const original = await readReview(owner, projectId, frozen.reviewId);
      assert.equal(original.decision?.actorDisplayName, "Captured actor");
      assert.equal(original.decision?.actorRole, role);
      await f.database.query("update app.user_profile set display_name='Later name' where id=$1", [actorId]);
      if (role !== "OWNER") await changeProjectMember(owner, projectId, actorId, { key: randomUUID(), role: "VIEWER", expectedMemberVersion: 1 });
      assert.deepEqual((await readReview(owner, projectId, frozen.reviewId)).decision, original.decision);
      await assert.rejects(f.database.query("update app.review_decision set actor_display_name='Forged' where review_id=$1", [frozen.reviewId]), { code: "23514", constraint: "review_decision_immutable" });
    }
  });
});

test("held actor profile captures the committed name after stale profile resolution", { skip: !canRun }, async () => {
  await withFixture(async f => {
    const { owner, approver, projectId, frozen, decision } = await readyDecision(f, "REVIEWER"), actorId = await f.profileId(approver);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect(); await holder.query("begin");
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("select id from app.user_profile where id=$1 for update", [actorId]);
      const pid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid;
      pending = reviewWrites.decideReview(approver, projectId, frozen.reviewId, decision, randomUUID());
      await waitForWaiters(f.database, pid, 1);
      await holder.query("update app.user_profile set display_name='Committed while waiting' where id=$1", [actorId]);
      await holder.query("commit");
      await pending;
      assert.equal((await readReview(owner, projectId, frozen.reviewId)).decision?.actorDisplayName, "Committed while waiting");
    } finally { await holder.query("rollback"); await holder.end(); await pending?.catch(() => undefined); }
  });
});

test("ECMAScript blank reasons reject negative actions atomically and normalize optional approval", { skip: !canRun }, async () => {
  await withFixture(async f => {
    for (const reason of ["\u00a0", "\ufeff"]) {
      const { owner, projectId, frozen, decision } = await readyDecision(f), before = await decisionState(f, projectId);
      for (const kind of ["REQUEST_CHANGES", "REJECT"] as const)
        await assert.rejects(reviewWrites.decideReview(owner, projectId, frozen.reviewId, { ...decision, decision: kind, reason }, randomUUID()), refused("INVALID_INPUT"));
      await assert.rejects(withdrawReview(owner, projectId, frozen.reviewId, { expectedReviewVersion: 1, reason }, randomUUID()), refused("INVALID_INPUT"));
      assert.deepEqual(await decisionState(f, projectId), before);
      const input = { ...decision, reason }, key = randomUUID(), result = await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key);
      assert.equal((await readReview(owner, projectId, frozen.reviewId)).decision?.comment, null);
      assert.deepEqual(await reviewWrites.decideReview(owner, projectId, frozen.reviewId, input, key), { ...result, replayed: true });
    }
  });
});
