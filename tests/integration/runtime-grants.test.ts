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
