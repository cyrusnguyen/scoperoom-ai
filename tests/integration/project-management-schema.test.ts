import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const canRun = Boolean(databaseUrl);

test("project management keeps version counters independent and grants only its required app_web writes", { skip: !canRun }, async () => {
  const database = new Client({ connectionString: databaseUrl! });
  await database.connect();
  const suffix = randomUUID();
  let ownerId = "";
  let approverId = "";
  let workspaceId = "";
  let projectId = "";
  let invitationId = "";
  try {
    const { rows: [owner] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`Project management owner ${suffix}`]);
    ownerId = owner!.id;
    const { rows: [approver] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`Project management approver ${suffix}`]);
    approverId = approver!.id;
    await database.query("begin");
    const { rows: [workspace] } = await database.query<{ id: string }>("insert into app.workspace (owner_id, name) values ($1, $2) returning id", [ownerId, `Project management workspace ${suffix}`]);
    workspaceId = workspace!.id;
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'OWNER')", [workspaceId, ownerId]);
    await database.query("commit");

    await database.query("begin");
    const { rows: [project] } = await database.query<{ id: string }>("insert into app.project (workspace_id, name) values ($1, $2) returning id", [workspaceId, `Project management project ${suffix}`]);
    projectId = project!.id;
    const { rows: [draft] } = await database.query<{ id: string }>("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{\"schemaVersion\":3,\"requirements\":{},\"flows\":{},\"nodes\":{},\"edges\":{},\"questions\":{},\"decisions\":{},\"scenarios\":{}}', '{\"schemaVersion\":1,\"nodes\":{}}') returning id", [projectId, ownerId]);
    await database.query("update app.project set current_draft_id = $1 where id = $2", [draft!.id, projectId]);
    await database.query("commit");
    await database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'VIEWER')", [projectId, approverId]);
    const { rows: [invitation] } = await database.query<{ id: string }>("insert into app.invitation (project_id, workspace_id, token_hash, verified_email, role, invited_by, expires_at) values ($1, $2, $3, $4, 'VIEWER', $5, current_timestamp + interval '7 days') returning id", [projectId, workspaceId, "a".repeat(64), `project-management-${suffix}@example.test`, ownerId]);
    invitationId = invitation!.id;

    await database.query("set role app_web");
    const { rows: [updatedProject] } = await database.query<{ settings_version: number; approval_policy_version: number; membership_version: number; designated_approver_id: string | null }>("update app.project set name = $1, settings_version = settings_version + 1, approval_policy_version = approval_policy_version + 1, membership_version = membership_version + 1, designated_approver_id = $2, event_sequence = event_sequence + 1, realtime_epoch = gen_random_uuid(), updated_at = current_timestamp where id = $3 returning settings_version, approval_policy_version, membership_version, designated_approver_id", [`Renamed ${suffix}`, approverId, projectId]);
    assert.deepEqual(updatedProject, { settings_version: 2, approval_policy_version: 2, membership_version: 2, designated_approver_id: approverId });
    const { rows: [membership] } = await database.query<{ role: string; active: boolean; version: number }>("update app.project_membership set role = 'REVIEWER', active = false, version = version + 1, updated_at = current_timestamp where project_id = $1 and profile_id = $2 returning role, active, version", [projectId, approverId]);
    assert.deepEqual(membership, { role: "REVIEWER", active: false, version: 2 });
    await database.query("update app.invitation set revoked_at = current_timestamp, version = version + 1 where id = $1", [invitationId]);
    const { rows: [archivedWorkspace] } = await database.query<{ status: string; version: number }>("update app.workspace set status = 'ARCHIVED', version = version + 1, updated_at = current_timestamp where id = $1 returning status, version", [workspaceId]);
    assert.deepEqual(archivedWorkspace, { status: "ARCHIVED", version: 2 });
    await database.query("reset role");
  } finally {
    await database.query("reset role").catch(() => undefined);
    if (projectId) await database.query("delete from app.project where id = $1", [projectId]).catch(() => undefined);
    if (workspaceId) await database.query("delete from app.workspace where id = $1", [workspaceId]).catch(() => undefined);
    if (approverId) await database.query("delete from app.user_profile where id = $1", [approverId]).catch(() => undefined);
    if (ownerId) await database.query("delete from app.user_profile where id = $1", [ownerId]).catch(() => undefined);
    await database.end();
  }
});
