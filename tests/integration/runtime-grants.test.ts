import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { requireEnv } from "../support/env.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";

const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "WORKER_DATABASE_URL"]);
const denied = (error: unknown) => (error as { code?: string }).code === "42501";

test("runtime roles cannot change project ownership or identity columns", { skip: !canRun }, async () => {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await admin.connect();
  const owner = await insertProfile(admin); const other = await insertProfile(admin);
  const projectId = await insertProject(admin, owner);
  try {
    for (const url of [process.env.DATABASE_URL!, process.env.WORKER_DATABASE_URL!]) {
      const runtime = new Client({ connectionString: url });
      await runtime.connect();
      try {
        await assert.rejects(runtime.query("update app.project set owner_id = $1 where id = $2", [other, projectId]), denied);
        await runtime.query("begin");
        await runtime.query("reset role");
        await assert.rejects(runtime.query("update app.project set owner_id = $1 where id = $2", [other, projectId]), denied);
        await runtime.query("rollback");
      } finally { await runtime.end(); }
    }
    const { rows } = await admin.query<{ role: string; col: string; allowed: boolean }>(`
      select r.role, c.col, has_column_privilege(r.role, c.tbl, c.col, 'UPDATE') as allowed
      from (values ('app_web'), ('app_worker'), ('app_web_runtime'), ('app_worker_runtime')) as r(role)
      cross join (values ('app.project', 'owner_id'), ('app.project', 'id'), ('app.project', 'created_at'),
                         ('app.project_membership', 'project_id'), ('app.project_membership', 'profile_id')) as c(tbl, col)`);
    assert.deepEqual(rows.filter((row) => row.allowed), []);
  } finally {
    await removeSchemaRows(admin, [owner, other]);
    await admin.end();
  }
});

test("the web runtime may update only draft content, positions and their revisions; the worker none", { skip: !canRun }, async () => {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ role: string; col: string }>(`
      select r.role, c.col
      from (values ('app_web'), ('app_worker')) as r(role)
      cross join (select attname::text as col from pg_attribute where attrelid = 'app.scope_draft'::regclass and attnum > 0 and not attisdropped) as c
      where has_column_privilege(r.role, 'app.scope_draft', c.col, 'UPDATE')
      order by r.role, c.col`);
    assert.deepEqual(rows, ["document_json", "document_revision", "layout_json", "layout_revision", "updated_at"].map((col) => ({ role: "app_web", col })));
  } finally {
    await admin.end();
  }
});

test("AI storage grants are column- and function-exact for the web and worker runtimes", { skip: !canRun }, async () => {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await admin.connect();
  try {
    const tables = ["source_document", "source_version", "ai_owner_allowance", "ai_budget_day", "ai_run", "ai_run_attempt", "rate_limit_bucket", "ai_suggestion_application", "ai_application_source"];
    const roles = ["app_web", "app_worker", "app_web_runtime", "app_worker_runtime"];
    const { rows } = await admin.query<{ role: string; tbl: string; col: string | null; priv: string }>(`
      select r.role, t.tbl, null::text as col, p.priv from unnest($1::text[]) as r(role) cross join unnest($2::text[]) as t(tbl)
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
        where has_table_privilege(r.role, 'app.' || t.tbl, p.priv)
      union all
      select r.role, t.tbl, a.attname::text, 'UPDATE' from unnest($1::text[]) as r(role) cross join unnest($2::text[]) as t(tbl)
        join pg_attribute a on a.attrelid = ('app.' || t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
        where has_column_privilege(r.role, 'app.' || t.tbl, a.attname, 'UPDATE') and not has_table_privilege(r.role, 'app.' || t.tbl, 'UPDATE')
      order by 1, 2, 4, 3`, [roles, tables]);
    const grants = (role: string) => rows.filter((row) => row.role === role).map((row) => `${row.tbl}:${row.priv}${row.col ? `(${row.col})` : ""}`);
    const web = [
      "ai_budget_day:INSERT", "ai_budget_day:SELECT", "ai_budget_day:UPDATE(reserved_runs)",
      "ai_application_source:INSERT", "ai_application_source:SELECT", "ai_suggestion_application:INSERT", "ai_suggestion_application:SELECT",
      "ai_owner_allowance:INSERT", "ai_owner_allowance:SELECT", "ai_owner_allowance:UPDATE(created_at)",
      "ai_run:INSERT", "ai_run:SELECT", "ai_run:UPDATE(cancel_requested_at)", "ai_run:UPDATE(disposition)", "ai_run:UPDATE(last_event_sequence)",
      "ai_run_attempt:SELECT",
      "source_document:INSERT", "source_document:SELECT", "source_document:UPDATE(current_version_id)", "source_document:UPDATE(last_event_sequence)", "source_document:UPDATE(updated_at)", "source_document:UPDATE(version)",
      "source_version:INSERT", "source_version:SELECT",
      "rate_limit_bucket:DELETE", "rate_limit_bucket:INSERT", "rate_limit_bucket:SELECT", "rate_limit_bucket:UPDATE(count)",
    ];
    const worker = [
      "ai_budget_day:SELECT", "ai_owner_allowance:SELECT",
      "ai_application_source:SELECT", "ai_suggestion_application:SELECT",
      "ai_run:SELECT", // no column UPDATE at all: dispatch leases and acknowledgements go through definer functions
      "ai_run_attempt:SELECT", "source_document:SELECT", "source_version:SELECT",
    ];
    assert.deepEqual(grants("app_web").sort(), [...web].sort());
    assert.deepEqual(grants("app_worker").sort(), [...worker].sort());
    // The NOINHERIT logins hold nothing themselves; they act only through SET ROLE to their group (proved on live connections elsewhere).
    for (const login of ["app_web_runtime", "app_worker_runtime"]) assert.deepEqual(grants(login), [], login);
    const { rows: functions } = await admin.query<{ role: string; fn: string }>(`
      select r.role, p.proname::text as fn from unnest($1::text[]) as r(role) join pg_proc p on p.pronamespace = 'app'::regnamespace
      where p.proname = any($2::text[]) and has_function_privilege(r.role, p.oid, 'EXECUTE') order by 1, 2`,
      [roles, ["claim_ai_attempt", "settle_ai_attempt", "finish_ai_run", "expire_ai_run_bodies", "record_ai_event", "ai_actor_may_run", "settle_overdue_ai_runs", "lease_ai_dispatches", "lease_ai_dispatch", "ack_ai_dispatch", "begin_ai_validation", "cleanup_transient", "run_worker_cleanup"]]);
    const callable = (role: string) => functions.filter((row) => row.role === role).map((row) => row.fn);
    for (const role of ["app_web_runtime", "app_worker_runtime"]) assert.deepEqual(callable(role), [], role);
    assert.deepEqual(callable("app_web"), ["ack_ai_dispatch", "lease_ai_dispatch", "settle_overdue_ai_runs"]); // web settles only overdue runs and delivers the first dispatch; it never claims, settles attempts or finishes
    assert.deepEqual(callable("app_worker"), ["ack_ai_dispatch", "begin_ai_validation", "claim_ai_attempt", "finish_ai_run", "lease_ai_dispatch", "lease_ai_dispatches", "run_worker_cleanup", "settle_ai_attempt"]); // the worker reaches expiry and cleanup only through the environment-validated wrapper
    const { rows: [project] } = await admin.query<{ web: boolean; worker: boolean }>("select has_column_privilege('app_web', 'app.project', 'ai_revision', 'UPDATE') as web, has_column_privilege('app_worker', 'app.project', 'ai_revision', 'UPDATE') as worker");
    assert.deepEqual(project, { web: true, worker: false });
  } finally {
    await admin.end();
  }
});
