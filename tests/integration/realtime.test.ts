import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { saveChanges } from "../../src/features/drafts/server/changes.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject } from "../../src/features/projects/server/management.ts";
import { getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";
import { draftOf, flowBatch, hintsFor, saveFlow } from "./support/hints.ts";

// SQL-level matrix for the private Realtime policies. Real-JWT socket checks live in the browser/socket suite.
const denied = (error: unknown) => (error as { code?: string }).code === "42501";
type Capability = "receive_broadcast" | "send_broadcast" | "presence";
const randomEpoch = "00000000-0000-4000-8000-000000000000";

/** Runs `run` inside a rolled-back transaction as `authenticated` with the given JWT subject and Realtime topic. */
async function asBrowser<T>(database: Client, claims: Record<string, unknown> | null, topic: string, run: () => Promise<T>, before?: () => Promise<void>) {
  await database.query("begin");
  try {
    await before?.();
    await database.query("set local role authenticated");
    await database.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [claims ? JSON.stringify({ role: "authenticated", ...claims }) : "", topic]);
    return await run();
  } finally {
    await database.query("rollback");
  }
}

test("can_realtime grants exact capabilities by current membership and project status", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project, join, profileId }) => {
    const [owner, editor, reviewer, viewer, removed, stranger] = await Promise.all(["Owner", "Editor", "Reviewer", "Viewer", "Removed", "Stranger"].map((label) => user(label)));
    const projectId = await project(owner!);
    await join(owner!, projectId, editor!, "EDITOR");
    await join(owner!, projectId, reviewer!, "REVIEWER");
    await join(owner!, projectId, viewer!, "VIEWER");
    await join(owner!, projectId, removed!, "EDITOR");
    await database.query("update app.project_membership set active = false, deactivated_sequence = 1 where project_id = $1 and profile_id = $2", [projectId, await profileId(removed!)]);
    const { rows: [{ epoch }] } = await database.query<{ epoch: string }>("select realtime_epoch::text as epoch from app.project where id = $1", [projectId]);
    const events = `project:${projectId}:${epoch}:events`;
    const collab = `project:${projectId}:${epoch}:collab`;
    const can = (who: Identity | null, topic: string, capability: Capability | (string & {}), claims: Record<string, unknown> = {}) =>
      asBrowser(database, who ? { sub: who.authUserId, ...claims } : null, topic, async () => (await database.query<{ ok: boolean }>("select app_private.can_realtime($1, $2) as ok", [topic, capability])).rows[0]!.ok);
    const matrix = async (expected: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean]>) => {
      // Each row is [receive events, send events, presence events, receive collab, send collab, presence collab].
      for (const [name, who] of Object.entries({ owner, editor, reviewer, viewer, removed, stranger })) {
        const got = [
          await can(who!, events, "receive_broadcast"), await can(who!, events, "send_broadcast"), await can(who!, events, "presence"),
          await can(who!, collab, "receive_broadcast"), await can(who!, collab, "send_broadcast"), await can(who!, collab, "presence"),
        ];
        assert.deepEqual(got, expected[name], name);
      }
    };

    await matrix({
      owner: [true, false, false, true, true, true], editor: [true, false, false, true, true, true],
      reviewer: [true, false, false, true, false, true], viewer: [true, false, false, true, false, true],
      removed: [false, false, false, false, false, false], stranger: [false, false, false, false, false, false],
    });

    // Anonymous, unauthenticated, malformed, wrong-project and stale-epoch inputs fail closed without errors.
    assert.equal(await can(owner!, collab, "receive_broadcast", { is_anonymous: true }), false);
    assert.equal(await can(null, collab, "receive_broadcast"), false);
    for (const topic of ["", "garbage", collab.toUpperCase(), `${collab}:extra`, collab.replace(projectId, "not-a-uuid"), `project:${epoch}:${projectId}:collab`, `project:${projectId}:${projectId}:collab`, `project:${projectId}:${epoch}:other`]) {
      assert.equal(await can(owner!, topic, "receive_broadcast"), false, topic);
    }
    assert.equal(await can(owner!, collab, "manage"), false);
    assert.equal(await can(owner!, collab, "SEND_BROADCAST"), false);

    // Archived projects stay readable and presence-capable but nobody can send Broadcast.
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [projectId]);
    await matrix({
      owner: [true, false, false, true, false, true], editor: [true, false, false, true, false, true],
      reviewer: [true, false, false, true, false, true], viewer: [true, false, false, true, false, true],
      removed: [false, false, false, false, false, false], stranger: [false, false, false, false, false, false],
    });

    // Deleting projects are denied to everyone.
    await database.query("update app.project set status = 'DELETING' where id = $1", [projectId]);
    const none: [boolean, boolean, boolean, boolean, boolean, boolean] = [false, false, false, false, false, false];
    await matrix({ owner: none, editor: none, reviewer: none, viewer: none, removed: none, stranger: none });

    // A rotated epoch retires the old topic even for the owner.
    await database.query("update app.project set status = 'ACTIVE', realtime_epoch = gen_random_uuid() where id = $1", [projectId]);
    assert.equal(await can(owner!, collab, "receive_broadcast"), false);
    assert.equal(await can(owner!, events, "receive_broadcast"), false);
  });
});

test("provider policies apply the capabilities to Broadcast and Presence rows", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project, join }) => {
    const [owner, editor, viewer, stranger] = await Promise.all(["Owner", "Editor", "Viewer", "Stranger"].map((label) => user(label)));
    const projectId = await project(owner!);
    await join(owner!, projectId, editor!, "EDITOR");
    await join(owner!, projectId, viewer!, "VIEWER");
    const { rows: [{ epoch }] } = await database.query<{ epoch: string }>("select realtime_epoch::text as epoch from app.project where id = $1", [projectId]);
    const topics = { events: `project:${projectId}:${epoch}:events`, collab: `project:${projectId}:${epoch}:collab` };
    const insert = (who: Identity, topic: string, extension: "broadcast" | "presence") =>
      asBrowser(database, { sub: who.authUserId }, topic, async () => { await database.query("insert into realtime.messages (topic, extension, private) values ($1, $2, true)", [topic, extension]); });
    const inserted = async (who: Identity, topic: string, extension: "broadcast" | "presence") => insert(who, topic, extension).then(() => true, (error) => { assert.ok(denied(error), String(error)); return false; });

    assert.equal(await inserted(owner!, topics.collab, "broadcast"), true);
    assert.equal(await inserted(editor!, topics.collab, "broadcast"), true);
    assert.equal(await inserted(viewer!, topics.collab, "broadcast"), false);
    assert.equal(await inserted(stranger!, topics.collab, "broadcast"), false);
    assert.equal(await inserted(viewer!, topics.collab, "presence"), true);
    assert.equal(await inserted(stranger!, topics.collab, "presence"), false);
    for (const who of [owner!, editor!, viewer!]) {
      assert.equal(await inserted(who, topics.events, "broadcast"), false, "browsers never send on events");
      assert.equal(await inserted(who, topics.events, "presence"), false, "events has no presence");
    }

    // Reads: members receive Broadcast on both topics but Presence only on collab; others see nothing.
    const visible = (who: Identity, topic: string) => asBrowser(database, { sub: who.authUserId }, topic, async () => {
      const { rows } = await database.query<{ extension: string }>("select extension from realtime.messages where topic = $1 order by extension", [topic]);
      return rows.map((row) => row.extension);
    }, async () => {
      for (const [topic, extension] of [[topics.events, "broadcast"], [topics.events, "presence"], [topics.collab, "broadcast"], [topics.collab, "presence"]]) {
        await database.query("insert into realtime.messages (topic, extension, private) values ($1, $2, true)", [topic, extension]);
      }
    });
    assert.deepEqual(await visible(viewer!, topics.events), ["broadcast"]);
    assert.deepEqual(await visible(viewer!, topics.collab), ["broadcast", "presence"]);
    assert.deepEqual(await visible(stranger!, topics.events), []);
    assert.deepEqual(await visible(stranger!, topics.collab), []);
  });
});

test("only the browser role can execute the helper and browsers cannot read application tables", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user("Owner");
    const projectId = await project(owner);
    const claims = { sub: owner.authUserId };
    const topic = `project:${projectId}:${randomEpoch}:collab`;
    for (const role of ["anon", "app_web", "app_worker", "app_web_runtime", "app_worker_runtime", "app_realtime_notifier"]) {
      const { rows: [row] } = await database.query<{ ok: boolean }>("select has_function_privilege($1, 'app_private.can_realtime(text,text)', 'EXECUTE') as ok", [role]);
      assert.equal(row!.ok, false, role);
    }
    const { rows: [publicExecute] } = await database.query<{ ok: boolean }>("select exists(select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'app_private.can_realtime(text,text)'::regprocedure and a.grantee = 0) as ok");
    assert.equal(publicExecute!.ok, false, "PUBLIC");
    for (const table of ["app.project", "app.project_membership", "app.user_profile", "app.scope_draft"]) {
      await asBrowser(database, claims, topic, async () => {
        await assert.rejects(database.query(`select 1 from ${table} limit 1`), denied, table);
      });
    }
    await asBrowser(database, claims, topic, async () => {
      // The helper stays callable but never exposes the schema it reads.
      await database.query("select app_private.can_realtime($1, 'presence')", [topic]);
      await assert.rejects(database.query("select 1 from app_private.can_realtime limit 1"), (error: unknown) => (error as { code?: string }).code === "42P01");
    });
    for (const role of ["anon", "app_web", "app_worker"]) {
      await database.query("begin");
      try {
        await database.query(`set local role ${role}`);
        await assert.rejects(database.query("select app_private.can_realtime($1, 'presence')", [topic]), denied, role);
      } finally { await database.query("rollback"); }
    }
  });
});

test("helper ownership, search path and role privileges are minimal", { skip: !canRun }, async () => {
  await withFixture(async ({ database }) => {
    const { rows: [fn] } = await database.query<{ owner: string; secdef: boolean; language: string; volatility: string; config: string[]; source: string }>(`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, l.lanname as language, p.provolatile as volatility, p.proconfig as config, p.prosrc as source
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'app_private.can_realtime(text,text)'::regprocedure`);
    assert.equal(fn!.owner, "app_realtime_reader");
    assert.equal(fn!.secdef, true);
    assert.equal(fn!.language, "sql");
    assert.equal(fn!.volatility, "s");
    assert.deepEqual(fn!.config, ["search_path=\"\""]);
    assert.doesNotMatch(fn!.source, /\bexecute\b/i);

    const { rows: roles } = await database.query<{ rolname: string; rolsuper: boolean; rolinherit: boolean; rolcanlogin: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "select rolname, rolsuper, rolinherit, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname in ('app_realtime_reader', 'app_realtime_notifier') order by rolname");
    assert.deepEqual(roles.map((role) => role.rolname), ["app_realtime_notifier", "app_realtime_reader"]);
    for (const role of roles) assert.deepEqual([role.rolsuper, role.rolinherit, role.rolcanlogin, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole], [false, false, false, false, false, false], role.rolname);
    const { rows: members } = await database.query("select 1 from pg_auth_members where roleid in ('app_realtime_reader'::regrole, 'app_realtime_notifier'::regrole) and (member <> 'postgres'::regrole or inherit_option or set_option)");
    assert.equal(members.length, 0, "no login or runtime role holds the restricted owners");

    // Reader: column SELECT only, on exactly the columns the join needs.
    const { rows: readerColumns } = await database.query<{ tbl: string; col: string }>(`
      select c.relname as tbl, a.attname as col from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and has_column_privilege('app_realtime_reader', c.oid, a.attnum, 'SELECT') order by 1, 2`);
    assert.deepEqual(readerColumns.map((row) => `${row.tbl}.${row.col}`), [
      "project.id", "project.owner_id", "project.realtime_epoch", "project.status",
      "project_membership.active", "project_membership.profile_id", "project_membership.project_id", "project_membership.role",
      "user_profile.auth_user_id", "user_profile.id",
    ]);
    const { rows: writable } = await database.query(`
      select c.relname from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind = 'r'
      and (has_table_privilege('app_realtime_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('app_realtime_reader', c.oid, 'INSERT,UPDATE,REFERENCES'))`);
    assert.equal(writable.length, 0);

    // Notifier: nothing in app, only Realtime send.
    const { rows: [notifier] } = await database.query<{ realtime_usage: boolean; send: boolean; app_usage: boolean; private_usage: boolean; can_realtime: boolean }>(`
      select has_schema_privilege('app_realtime_notifier', 'realtime', 'USAGE') as realtime_usage,
             has_function_privilege('app_realtime_notifier', 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE') as send,
             has_schema_privilege('app_realtime_notifier', 'app', 'USAGE') as app_usage,
             has_schema_privilege('app_realtime_notifier', 'app_private', 'USAGE') as private_usage,
             has_function_privilege('app_realtime_notifier', 'app_private.can_realtime(text,text)', 'EXECUTE') as can_realtime`);
    assert.deepEqual(notifier, { realtime_usage: true, send: true, app_usage: false, private_usage: true, can_realtime: false });

    // Browsers: helper schema and function only; no application schema access and no other provider policies.
    const { rows: [browser] } = await database.query<{ private_usage: boolean; app_usage: boolean; anon_private: boolean; web_private: boolean }>(`
      select has_schema_privilege('authenticated', 'app_private', 'USAGE') as private_usage, has_schema_privilege('authenticated', 'app', 'USAGE') as app_usage,
             has_schema_privilege('anon', 'app_private', 'USAGE') as anon_private,
             has_schema_privilege('app_web', 'app_private', 'USAGE') or has_schema_privilege('app_worker', 'app_private', 'USAGE') as web_private`);
    assert.deepEqual(browser, { private_usage: true, app_usage: false, anon_private: false, web_private: false });
    const { rows: [rls] } = await database.query<{ enabled: boolean; owner: string }>("select relrowsecurity as enabled, pg_get_userbyid(relowner) as owner from pg_class where oid = 'realtime.messages'::regclass");
    assert.deepEqual(rls, { enabled: true, owner: "supabase_realtime_admin" });
    const { rows: policies } = await database.query<{ policyname: string; cmd: string; roles: string[] }>("select policyname::text, cmd::text, roles::text[] from pg_policies where schemaname = 'realtime' and tablename = 'messages' order by policyname");
    assert.deepEqual(policies, [
      { policyname: "scoperoom_rt_hint", cmd: "INSERT", roles: ["app_realtime_notifier"] },
      { policyname: "scoperoom_rt_insert", cmd: "INSERT", roles: ["authenticated"] },
      { policyname: "scoperoom_rt_select", cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });
});


const HINT_KEYS = ["epoch", "eventSequence", "projectId", "type"];
/** The provider adds its own message id to a stored payload; everything else must be the four-field contract. */
const contract = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "id"));

test("a changed save commits exactly one four-field hint on the epoch topic of that update", { skip: !canRun }, async () => {
  const runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  try {
    assert.equal((await runtime.query<{ role: string }>("select current_user as role")).rows[0]!.role, "app_web", "the services run as the web runtime role, not a privileged one");
  } finally { await runtime.end(); }
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const projectId = await project(owner);
    assert.deepEqual(await hintsFor(database, projectId), [], "project creation needs no hint");
    const { rows: [before] } = await database.query<{ epoch: string; sequence: number }>("select realtime_epoch::text as epoch, event_sequence::int as sequence from app.project where id = $1", [projectId]);
    const saved = await saveFlow(owner, projectId);
    const [hint, ...rest] = await hintsFor(database, projectId);
    assert.equal(rest.length, 0, "one project UPDATE per save, two audit entries, one hint");
    assert.deepEqual(Object.keys(contract(hint!.payload)).sort(), HINT_KEYS);
    assert.deepEqual(contract(hint!.payload), { type: "PROJECT_CHANGED", projectId, epoch: before!.epoch, eventSequence: saved.eventSequence });
    assert.equal(saved.eventSequence, before!.sequence + 2);
    assert.equal(hint!.topic, `project:${projectId}:${before!.epoch}:events`);
  });
});

test("no-op saves, receipt replays and refused saves add no audit and no hint", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const projectId = await project(owner);
    const { draftId, base } = await draftOf(owner, projectId);
    const { start, body } = flowBatch(base.documentRevision);
    const key = randomUUID();
    const saved = await saveChanges(owner, projectId, draftId, { ...body, key });
    const state = async () => ({
      hints: (await hintsFor(database, projectId)).length,
      audit: Number((await database.query("select count(*) from app.audit_event where project_id = $1", [projectId])).rows[0].count),
      sequence: (await getProjectStatus(owner, projectId)).eventSequence,
    });
    const settled = await state();
    assert.deepEqual(settled, { hints: 1, audit: 3, sequence: 3 }); // creation audits sequence 1 without a hint

    const noOp = await saveChanges(owner, projectId, draftId, { commands: [{ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: start, label: "Step" } }], moves: [], key: randomUUID() });
    assert.equal(noOp.eventSequence, saved.eventSequence);
    assert.deepEqual(await state(), settled, "an effective no-op keeps every counter");

    assert.deepEqual(await saveChanges(owner, projectId, draftId, { ...body, key }), { ...saved, replayed: true });
    assert.deepEqual(await state(), settled, "a receipt replay writes nothing");

    await assert.rejects(saveChanges(owner, projectId, draftId, { ...flowBatch(base.documentRevision).body, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "STALE_DOCUMENT_REVISION");
    assert.deepEqual(await state(), settled, "a refused save writes nothing");
  });
});

test("a management rotation hint names the epoch of the row it was fired for", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const projectId = await project(owner);
    await archiveProject(owner, projectId, { expectedProjectVersion: (await getProjectStatus(owner, projectId)).version, reason: "Wrapped up", key: randomUUID() });
    const hints = await hintsFor(database, projectId);
    assert.ok(hints.length >= 1);
    for (const hint of hints) {
      const payload = contract(hint.payload);
      assert.deepEqual(Object.keys(payload).sort(), HINT_KEYS);
      assert.equal(hint.topic, `project:${payload.projectId}:${payload.epoch}:events`, "topic and payload come from the same NEW row");
    }
  });
});

test("only the notifier owns the hint functions and no application or browser role can execute them", { skip: !canRun }, async () => {
  await withFixture(async ({ database }) => {
    const functions = ["app_private.enqueue_project_hint(jsonb,text)", "app_private.notify_project_changed()"];
    for (const signature of functions) {
      const { rows: [row] } = await database.query<{ owner: string; secdef: boolean; config: string[]; shared: boolean }>(
        `select pg_get_userbyid(proowner) as owner, prosecdef as secdef, proconfig as config,
           exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a where a.grantee <> proowner) as shared
         from pg_proc where oid = $1::regprocedure`, [signature]);
      assert.deepEqual(row, { owner: "app_realtime_notifier", secdef: true, config: ["search_path=\"\""], shared: false }, signature);
      for (const role of ["anon", "authenticated", "app_web", "app_worker", "app_web_runtime", "app_worker_runtime", "app_migrator_runtime", "app_realtime_reader"]) {
        const { rows: [access] } = await database.query<{ ok: boolean }>("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, signature]);
        assert.equal(access!.ok, false, `${role} ${signature}`);
      }
    }
    const topic = `project:${randomUUID()}:${randomEpoch}:events`;
    const payload = JSON.stringify({ type: "PROJECT_CHANGED", projectId: randomUUID(), epoch: randomEpoch, eventSequence: 1 });
    const runtime = new Client({ connectionString: process.env.DATABASE_URL });
    await runtime.connect();
    try { await assert.rejects(runtime.query("select app_private.enqueue_project_hint($1::jsonb, $2)", [payload, topic]), denied, "runtime login"); } finally { await runtime.end(); }
    for (const role of ["anon", "authenticated"]) {
      await database.query("begin");
      try {
        await database.query(`set local role ${role}`);
        await assert.rejects(database.query("select app_private.enqueue_project_hint($1::jsonb, $2)", [payload, topic]), denied, role);
      } finally { await database.query("rollback"); }
    }
    assert.deepEqual((await database.query("select 1 from realtime.messages where topic = $1", [topic])).rows, [], "no fabricated hint");
    const { rows: [trigger] } = await database.query<{ enabled: string; definition: string }>(
      "select tgenabled as enabled, pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid = 'app.project'::regclass and tgname = 'project_changed_hint'");
    assert.equal(trigger!.enabled, "O");
    assert.equal(trigger!.definition, "CREATE TRIGGER project_changed_hint AFTER UPDATE OF event_sequence ON app.project FOR EACH ROW WHEN ((new.event_sequence > old.event_sequence)) EXECUTE FUNCTION app_private.notify_project_changed()");
  });
});
