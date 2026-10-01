import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import { parseHint } from "../../src/features/collaboration/contracts/messages.ts";
import { saveChanges } from "../../src/features/drafts/server/changes.ts";
import { getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { draftOf, flowBatch, hintsFor, saveFlow } from "../integration/support/hints.ts";
import { SILENCE_MS, withRealtimeFixture } from "./support.ts";

// PROJECT_CHANGED hints over real sockets, plus fault injection. This file runs only in the serial test:realtime suite: it replaces an
// application-owned function on the disposable stack and adds a temporary constraint, which the concurrent integration glob must never see.
const CONTRACT = ["epoch", "eventSequence", "projectId", "type"];

test("a committed save delivers exactly the four-field hint to admitted subscribers (RT-028)", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, viewer, stranger] = await Promise.all(["Owner", "Viewer", "Stranger"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, viewer!, "VIEWER");
    const { events } = (await getProjectBootstrap(owner!, projectId)).realtime;
    const { realtimeEpoch, eventSequence } = await getProjectStatus(owner!, projectId);
    const ownerEvents = await rt.join(await rt.client(owner!), events); // subscribers are admitted before the save
    const viewerEvents = await rt.join(await rt.client(viewer!), events);
    const delivered = [ownerEvents, viewerEvents].map((channel) => rt.receive(channel, "PROJECT_CHANGED"));
    const earlier = (await hintsFor(fixture.database, projectId)).length; // invitations already advanced the sequence
    const saved = await saveFlow(owner!, projectId);
    for (const payload of await Promise.all(delivered)) {
      // The actual delivered JSON: the four documented fields and nothing else. The installed realtime.send adds only its own random
      // message id, which carries no project data and is the one key clients must tolerate.
      const { id, ...fields } = payload as Record<string, unknown>;
      assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.deepEqual(Object.keys(fields).sort(), CONTRACT);
      assert.deepEqual(fields, { type: "PROJECT_CHANGED", projectId, epoch: realtimeEpoch, eventSequence: saved.eventSequence });
      assert.deepEqual(parseHint(payload), { type: "PROJECT_CHANGED", projectId, epoch: realtimeEpoch, eventSequence: saved.eventSequence }, "the browser parser accepts the real delivered hint, provider id included");
    }
    assert.equal(saved.eventSequence, Number(eventSequence) + 2);
    assert.equal((await hintsFor(fixture.database, projectId)).length, earlier + 1, "one hint per changed save");

    // A non-member cannot be admitted to that topic, so it can never observe the hint.
    await assert.rejects(rt.join(await rt.client(stranger!), events), /Unauthorized|permissions/i);
  });
});

const ADAPTER = "app_private.enqueue_project_hint(jsonb,text)";
const RAISING_ADAPTER = `create or replace function app_private.enqueue_project_hint(payload jsonb, topic text) returns void language plpgsql security definer set search_path = '' as $$
  begin raise exception 'injected enqueue failure'; end; $$`;

/** Everything about the adapter that must survive a fault-injection round trip. */
const adapterState = async (database: Client) =>
  (await database.query("select pg_get_functiondef(oid) as definition, pg_get_userbyid(proowner) as owner, proacl::text as acl, proconfig, prosecdef from pg_proc where oid = $1::regprocedure", [ADAPTER])).rows[0];

/** Runs `sql` as a function's restricted owner: membership exists only inside this one transaction. Test-only; production never holds these roles. */
async function asOwner(database: Client, role: string, sql: string) {
  await database.query("begin");
  try {
    await database.query(`grant ${role} to current_user with inherit false, set true`);
    await database.query(`grant create on schema app_private to ${role}`); // CREATE OR REPLACE checks the schema even for the owner
    await database.query(`set local role ${role}`);
    await database.query(sql);
    await database.query("reset role");
    await database.query(`revoke create on schema app_private from ${role}`);
    await database.query(`revoke ${role} from current_user`);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
}
const asNotifier = (database: Client, sql: string) => asOwner(database, "app_realtime_notifier", sql);

/** Runs the guarded read-only verification the way `test:realtime` and `db:migrate` do. Resolves its exit status and error text (never secrets). */
const verifySetup = () => {
  const run = spawnSync(process.execPath, ["scripts/db/realtime.mjs", "verify"], { encoding: "utf8" });
  return { ok: run.status === 0, error: run.stderr };
};

test("a failing hint enqueue never costs the save: content, audit, sequence and receipt survive", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const owner = await fixture.user("Owner");
    const projectId = await fixture.project(owner);
    const { events } = (await getProjectBootstrap(owner, projectId)).realtime;
    const ownerEvents = await rt.join(await rt.client(owner), events);
    const original = await adapterState(fixture.database);
    assert.equal(original.owner, "app_realtime_notifier");
    const { draftId, base } = await draftOf(owner, projectId);
    const { flowId, body } = flowBatch(base.documentRevision);
    const key = randomUUID();
    const sequenceBefore = Number((await getProjectStatus(owner, projectId)).eventSequence);
    const hintsBefore = (await hintsFor(fixture.database, projectId)).length;
    const silence = rt.receive(ownerEvents, "PROJECT_CHANGED", SILENCE_MS + 3_000).then(() => true, () => false);
    let saved;
    try {
      await asNotifier(fixture.database, RAISING_ADAPTER);
      assert.match((await adapterState(fixture.database)).definition, /injected enqueue failure/);
      const drifted = verifySetup();
      assert.equal(drifted.ok, false, "guarded verification rejects the swapped adapter body");
      assert.match(drifted.error, /enqueue_project_hint.*body differs/);
      saved = await saveChanges(owner, projectId, draftId, { ...body, key });
    } finally {
      await asNotifier(fixture.database, original.definition);
    }
    assert.deepEqual(await adapterState(fixture.database), original, "definition, owner, ACL and search path restored exactly");
    assert.equal(verifySetup().ok, true, "guarded verification passes again after the restore");

    // The save is complete and readable; only the advisory hint is missing.
    assert.equal(saved.documentRevision, base.documentRevision + 2);
    assert.equal(saved.eventSequence, sequenceBefore + 2);
    const draft = await getDraft(owner, projectId, draftId);
    assert.equal(draft.documentRevision, saved.documentRevision);
    assert.ok(draft.document.flows[flowId]);
    const { rows: [audit] } = await fixture.database.query("select count(*)::int as count, max(sequence)::int as last from app.audit_event where project_id = $1 and sequence > $2", [projectId, sequenceBefore]);
    assert.deepEqual(audit, { count: 2, last: saved.eventSequence });
    const { rows: [receipt] } = await fixture.database.query("select result from app.mutation_receipt where scope_id = $1 and key = $2", [projectId, key]);
    assert.equal(receipt.result.eventSequence, saved.eventSequence);
    assert.equal(Number((await getProjectStatus(owner, projectId)).eventSequence), saved.eventSequence, "authorized status observes the new sequence");
    assert.equal((await hintsFor(fixture.database, projectId)).length, hintsBefore, "no hint was enqueued");
    assert.equal(await silence, false, "nothing was delivered");
    assert.deepEqual(await saveChanges(owner, projectId, draftId, { ...body, key }), { ...saved, replayed: true });

    // Control: with the original adapter back, the next changed save delivers again.
    const delivered = rt.receive(ownerEvents, "PROJECT_CHANGED");
    const next = await saveFlow(owner, projectId);
    assert.equal(((await delivered) as { eventSequence: number }).eventSequence, next.eventSequence);
  });
});

test("a failing required audit insert rolls back content, counter, receipt and hint together", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const owner = await fixture.user("Owner");
    const projectId = await fixture.project(owner);
    const { events } = (await getProjectBootstrap(owner, projectId)).realtime;
    const { draftId, base } = await draftOf(owner, projectId);
    const { flowId, body } = flowBatch(base.documentRevision);
    const key = randomUUID();
    const snapshot = async () => ({
      revision: (await getDraft(owner, projectId, draftId)).documentRevision,
      sequence: Number((await getProjectStatus(owner, projectId)).eventSequence),
      audit: Number((await fixture.database.query("select count(*) from app.audit_event where project_id = $1", [projectId])).rows[0].count),
      receipts: Number((await fixture.database.query("select count(*) from app.mutation_receipt where scope_id = $1 and key = $2", [projectId, key])).rows[0].count),
      hints: (await hintsFor(fixture.database, projectId)).length,
    });
    const before = await snapshot();

    // Isolated transaction: the trigger's hint is visible inside it, then a required audit insert fails and everything is rolled back.
    await fixture.database.query("begin");
    let inside = -1;
    try {
      await fixture.database.query("update app.project set event_sequence = event_sequence + 1 where id = $1", [projectId]);
      inside = (await hintsFor(fixture.database, projectId)).length;
      await assert.rejects(fixture.database.query("insert into app.audit_event (project_id, sequence, actor_id, action, entity_refs, metadata) values ($1, 0, (select owner_id from app.project where id = $1), 'X', '[]', '{}')", [projectId]), { code: "23514" });
    } finally {
      await fixture.database.query("rollback");
    }
    assert.equal(inside, before.hints + 1, "the hint row is written inside the transaction");
    assert.deepEqual(await snapshot(), before, "a rolled-back transaction leaves no hint");

    // Through the service: a temporary constraint makes only this project's audit rows fail after the counter UPDATE has already fired the trigger.
    const constraint = `zz_fail_audit_${projectId.replaceAll("-", "")}`.slice(0, 60);
    await fixture.database.query(`alter table app.audit_event add constraint ${constraint} check (project_id <> '${projectId}') not valid`);
    try {
      await assert.rejects(saveChanges(owner, projectId, draftId, { ...body, key }), (error: unknown) => error instanceof ProjectError && error.code === "UNAVAILABLE");
      assert.deepEqual(await snapshot(), before, "content, counter, audit, receipt and hint all rolled back");
      assert.equal((await getDraft(owner, projectId, draftId)).document.flows[flowId], undefined);
    } finally {
      await fixture.database.query(`alter table app.audit_event drop constraint if exists ${constraint}`);
    }
    const { rows: [left] } = await fixture.database.query("select count(*)::int as count from pg_constraint where conname = $1", [constraint]);
    assert.equal(left.count, 0, "the fault hook is removed");

    // Control: without the fault the same key and batch save and hint normally.
    const ownerEvents = await rt.join(await rt.client(owner), events);
    const delivered = rt.receive(ownerEvents, "PROJECT_CHANGED");
    const saved = await saveChanges(owner, projectId, draftId, { ...body, key });
    assert.equal(((await delivered) as { eventSequence: number }).eventSequence, saved.eventSequence);
    assert.equal((await snapshot()).hints, before.hints + 1);
  });
});

test("guarded verification rejects a permissive helper body and a leftover open policy", async () => {
  await withRealtimeFixture(async (fixture) => {
    const helper = "app_private.can_realtime(text,text)";
    const { rows: [original] } = await fixture.database.query("select pg_get_functiondef(oid) as definition from pg_proc where oid = $1::regprocedure", [helper]);
    try {
      await asOwner(fixture.database, "app_realtime_reader", "create or replace function app_private.can_realtime(topic text, capability text) returns boolean language sql stable security definer set search_path = '' as $$ select true $$");
      const permissive = verifySetup();
      assert.equal(permissive.ok, false);
      assert.match(permissive.error, /can_realtime.*body differs/);
    } finally {
      await asOwner(fixture.database, "app_realtime_reader", original.definition);
    }
    assert.equal(verifySetup().ok, true, "the restored helper verifies again");

    try {
      await fixture.database.query("create policy zz_open on realtime.messages for select to authenticated using (true)");
      const open = verifySetup();
      assert.equal(open.ok, false);
      assert.match(open.error, /zz_open/);
    } finally {
      await fixture.database.query("drop policy if exists zz_open on realtime.messages");
    }
    assert.equal(verifySetup().ok, true, "verification passes once the policy is gone");
  });
});
