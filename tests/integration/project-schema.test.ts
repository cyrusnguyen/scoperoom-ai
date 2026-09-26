import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { requireEnv } from "../support/env.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";

const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL"]);
const checkViolation = (error: unknown) => (error as { code?: string }).code === "23514";

async function withDatabase(run: (database: Client, profiles: string[]) => Promise<void>) {
  const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const profiles: string[] = [];
  await database.connect();
  try { await run(database, profiles); } finally { await removeSchemaRows(database, profiles); await database.end(); }
}

test("a project needs its editable current draft, and only one editable draft", { skip: !canRun }, async () => {
  await withDatabase(async (database, profiles) => {
    const owner = await insertProfile(database); profiles.push(owner);
    await database.query("begin");
    await database.query("insert into app.project (owner_id, name) values ($1, 'No draft')", [owner]);
    await assert.rejects(database.query("commit"), checkViolation);
    const projectId = await insertProject(database, owner);
    await assert.rejects(database.query("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{}'::jsonb, '{}'::jsonb)", [projectId, owner]), (error: unknown) => (error as { code?: string }).code === "23505");
  });
});

test("the project owner can never hold a membership row", { skip: !canRun }, async () => {
  await withDatabase(async (database, profiles) => {
    const owner = await insertProfile(database); profiles.push(owner);
    const projectId = await insertProject(database, owner);
    await assert.rejects(database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'EDITOR')", [projectId, owner]), checkViolation);
  });
});

test("membership deactivation and invitation ordering carry event sequences", { skip: !canRun }, async () => {
  await withDatabase(async (database, profiles) => {
    const owner = await insertProfile(database); const member = await insertProfile(database); profiles.push(owner, member);
    const projectId = await insertProject(database, owner);
    await database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'VIEWER')", [projectId, member]);
    await assert.rejects(database.query("update app.project_membership set active = false where project_id = $1 and profile_id = $2", [projectId, member]), checkViolation);
    await database.query("update app.project_membership set active = false, deactivated_sequence = 3 where project_id = $1 and profile_id = $2", [projectId, member]);
    await assert.rejects(database.query("insert into app.invitation (project_id, token_hash, verified_email, role, invited_by, expires_at) values ($1, repeat('a', 64), 'x@example.test', 'VIEWER', $2, now() + interval '1 day')", [projectId, owner]), (error: unknown) => (error as { code?: string }).code === "23502");
  });
});

test("receipt scopes are USER or PROJECT only", { skip: !canRun }, async () => {
  await withDatabase(async (database) => {
    const { rows } = await database.query<{ label: string }>("select enumlabel as label from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'mutation_scope_kind' order by enumsortorder");
    assert.deepEqual(rows.map((row) => row.label), ["USER", "PROJECT"]);
    const { rows: [stale] } = await database.query<{ tables: number }>("select count(*)::int as tables from pg_tables where schemaname = 'app' and tablename like 'workspace%'");
    assert.equal(stale!.tables, 0);
  });
});
