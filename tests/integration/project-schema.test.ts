import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const canRun = Boolean(databaseUrl);

test("project storage rejects a missing current draft and a second editable draft", { skip: !canRun }, async () => {
  const database = new Client({ connectionString: databaseUrl! });
  await database.connect();
  const suffix = randomUUID();
  let profileId = "";
  let workspaceId = "";
  let projectId = "";
  try {
    await database.query("begin");
    const { rows: [profile] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`Project schema ${suffix}`]);
    profileId = profile!.id;
    const { rows: [workspace] } = await database.query<{ id: string }>("insert into app.workspace (owner_id, name) values ($1, $2) returning id", [profileId, `Workspace ${suffix}`]);
    workspaceId = workspace!.id;
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'OWNER')", [workspaceId, profileId]);
    await database.query("commit");

    await database.query("begin");
    const { rows: [project] } = await database.query<{ id: string }>("insert into app.project (workspace_id, name) values ($1, $2) returning id", [workspaceId, `Project ${suffix}`]);
    projectId = project!.id;
    await assert.rejects(database.query("commit"), (error: unknown) => (error as { code?: string }).code === "23514");
    await database.query("rollback");

    await database.query("begin");
    const { rows: [validProject] } = await database.query<{ id: string }>("insert into app.project (workspace_id, name) values ($1, $2) returning id", [workspaceId, `Valid project ${suffix}`]);
    projectId = validProject!.id;
    const { rows: [draft] } = await database.query<{ id: string }>("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{\"schemaVersion\":3,\"requirements\":{},\"flows\":{},\"nodes\":{},\"edges\":{},\"questions\":{},\"decisions\":{},\"scenarios\":{}}', '{\"schemaVersion\":1,\"nodes\":{}}') returning id", [projectId, profileId]);
    await database.query("update app.project set current_draft_id = $1 where id = $2", [draft!.id, projectId]);
    await database.query("commit");

    await assert.rejects(
      database.query("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{}', '{}')", [projectId, profileId]),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    await database.query("insert into app.audit_event (project_id, workspace_id, sequence, actor_id, action, entity_refs, metadata) values ($1, $2, 1, $3, 'PROJECT_CREATED', '{}', '{}')", [projectId, workspaceId, profileId]);
    await database.query("begin");
    await database.query("delete from app.scope_draft where id = $1", [draft!.id]);
    await assert.rejects(database.query("commit"), (error: unknown) => (error as { code?: string }).code === "23503");
    await database.query("rollback");
    const { rows: [preserved] } = await database.query<{ projects: number; drafts: number; events: number }>("select (select count(*)::int from app.project where id = $1) as projects, (select count(*)::int from app.scope_draft where project_id = $1) as drafts, (select count(*)::int from app.audit_event where project_id = $1) as events", [projectId]);
    assert.deepEqual(preserved, { projects: 1, drafts: 1, events: 1 });    await database.query("delete from app.project where id = $1", [projectId]);
    const { rows: [remaining] } = await database.query<{ drafts: number; events: number }>("select (select count(*)::int from app.scope_draft where project_id = $1) as drafts, (select count(*)::int from app.audit_event where project_id = $1) as events", [projectId]);
    assert.deepEqual(remaining, { drafts: 0, events: 0 });
    projectId = "";
  } finally {
    if (projectId) await database.query("delete from app.audit_event where project_id = $1", [projectId]).catch(() => undefined);
    if (projectId) await database.query("delete from app.scope_draft where project_id = $1", [projectId]).catch(() => undefined);
    if (projectId) await database.query("delete from app.project where id = $1", [projectId]).catch(() => undefined);
    if (workspaceId) await database.query("delete from app.workspace_membership where workspace_id = $1", [workspaceId]).catch(() => undefined);
    if (workspaceId) await database.query("delete from app.workspace where id = $1", [workspaceId]).catch(() => undefined);
    if (profileId) await database.query("delete from app.user_profile where id = $1", [profileId]).catch(() => undefined);
    await database.end();
  }
});
