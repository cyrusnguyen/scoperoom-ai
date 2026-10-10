import { parseCandidatePayload } from "../../src/features/reviews/contracts/review.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { canRun, withFixture, type Fixture } from "./support/fixture.ts";
import { candidateFixture, addFlow, ids } from "../support/review-fixtures.ts";
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
