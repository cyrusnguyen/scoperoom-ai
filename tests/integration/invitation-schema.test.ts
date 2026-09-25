import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const canRun = Boolean(databaseUrl);

test("invitation storage requires paired acceptance and keeps invitation bindings immutable to app_web", { skip: !canRun }, async () => {
  const database = new Client({ connectionString: databaseUrl! });
  await database.connect();
  const suffix = randomUUID();
  let ownerId = "";
  let inviteeId = "";
  let workspaceId = "";
  let projectId = "";
  let invitationId = "";
  try {
    await database.query("begin");
    const { rows: [owner] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`Invitation owner ${suffix}`]);
    ownerId = owner!.id;
    const { rows: [invitee] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`Invitation invitee ${suffix}`]);
    inviteeId = invitee!.id;
    const { rows: [workspace] } = await database.query<{ id: string }>("insert into app.workspace (owner_id, name) values ($1, $2) returning id", [ownerId, `Invitation workspace ${suffix}`]);
    workspaceId = workspace!.id;
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'OWNER')", [workspaceId, ownerId]);
    await database.query("commit");
    await database.query("begin");
    const { rows: [project] } = await database.query<{ id: string }>("insert into app.project (workspace_id, name) values ($1, $2) returning id", [workspaceId, `Invitation project ${suffix}`]);
    projectId = project!.id;
    const { rows: [draft] } = await database.query<{ id: string }>("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{\"schemaVersion\":3,\"requirements\":{},\"flows\":{},\"nodes\":{},\"edges\":{},\"questions\":{},\"decisions\":{},\"scenarios\":{}}', '{\"schemaVersion\":1,\"nodes\":{}}') returning id", [projectId, ownerId]);
    await database.query("update app.project set current_draft_id = $1 where id = $2", [draft!.id, projectId]);
    await database.query("commit");

    await database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'EDITOR')", [projectId, inviteeId]);
    await assert.rejects(
      database.query("insert into app.invitation (project_id, workspace_id, token_hash, verified_email, role, invited_by, expires_at, accepted_at) values ($1, $2, $3, $4, 'VIEWER', $5, current_timestamp + interval '7 days', current_timestamp)", [projectId, workspaceId, "a".repeat(64), `invitee-${suffix}@example.test`, ownerId]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    const { rows: [invitation] } = await database.query<{ id: string }>("insert into app.invitation (project_id, workspace_id, token_hash, verified_email, role, invited_by, expires_at) values ($1, $2, $3, $4, 'VIEWER', $5, current_timestamp + interval '7 days') returning id", [projectId, workspaceId, "b".repeat(64), `invitee-${suffix}@example.test`, ownerId]);
    invitationId = invitation!.id;

    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role, active) values ($1, $2, 'MEMBER', false)", [workspaceId, inviteeId]);

    await database.query("set role app_web");
    const { rows: [reactivated] } = await database.query<{ active: boolean; version: number }>("update app.workspace_membership set active = true, version = version + 1, updated_at = current_timestamp where workspace_id = $1 and profile_id = $2 returning active, version", [workspaceId, inviteeId]);
    assert.deepEqual(reactivated, { active: true, version: 2 });

    await assert.rejects(
      database.query("update app.invitation set token_hash = $1 where id = $2", ["c".repeat(64), invitationId]),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await assert.rejects(
      database.query("update app.invitation set verified_email = $1 where id = $2", [`other-${suffix}@example.test`, invitationId]),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await database.query("reset role");
  } finally {
    await database.query("reset role").catch(() => undefined);
    if (projectId) await database.query("delete from app.project where id = $1", [projectId]).catch(() => undefined);
    if (workspaceId) await database.query("delete from app.workspace where id = $1", [workspaceId]).catch(() => undefined);
    if (inviteeId) await database.query("delete from app.user_profile where id = $1", [inviteeId]).catch(() => undefined);
    if (ownerId) await database.query("delete from app.user_profile where id = $1", [ownerId]).catch(() => undefined);
    await database.end();
  }
});
