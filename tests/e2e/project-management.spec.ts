import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const workspace = { id: "11111111-1111-4111-8111-111111111111", name: "Management workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ACTIVE", version: 1, canManage: true };
const project = { id: "22222222-2222-4222-8222-222222222222", workspaceId: workspace.id, name: "Management project", status: "ACTIVE", currentDraftId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-09-25T00:00:00.000Z" };

test.skip(!authUrl || !secretKey || !databaseUrl, "Requires isolated local Supabase Auth and database URLs");

test.describe("project management", () => {
  let admin: SupabaseClient;
  let database: Client;
  let authUserId = "";

  test.beforeEach(async ({ page }) => {
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    database = new Client({ connectionString: databaseUrl! });
    await database.connect();
    const email = `management-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: "Management-test-pass-1", email_confirm: true, user_metadata: { full_name: "Management Test" } });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    authUserId = data.user.id;
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("Management-test-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test.afterEach(async () => {
    if (authUserId) {
      await database.query("delete from app.user_profile where auth_user_id = $1", [authUserId]);
      await admin.auth.admin.deleteUser(authUserId);
    }
    await database.end();
  });

  test("an owner changes a member role, chooses an approver, and archives the project", async ({ page }) => {
    let status = { status: "ACTIVE", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null as string | null };
    const member = { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Casey Collaborator", role: "VIEWER", version: 1, designatedApprover: false };
    const otherWorkspace = { ...workspace, id: "55555555-5555-4555-8555-555555555555", name: "Other workspace", canManage: false };
    let removed = false;
    let showPendingInvite = false;
    const response = () => ({ project: status, members: removed ? [] : [member] });
    await page.route("**/api/workspaces", async (route) => route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Management Test", canCreate: false, maxWorkspaces: 1, ownedCount: 1, workspaces: [workspace, otherWorkspace] }) }) : route.continue());
    await page.route(`**/api/workspaces/${workspace.id}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, canCreateProject: true }, projects: [project] }) }));
    await page.route(`**/api/workspaces/${otherWorkspace.id}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: otherWorkspace.id, name: otherWorkspace.name, canCreateProject: false }, projects: [] }) }));
    await page.route(`**/api/projects/${project.id}/invitations`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ invitations: showPendingInvite ? [{ id: "66666666-6666-4666-8666-666666666666", verifiedEmail: "pending@example.test", role: "VIEWER", expiresAt: "2026-10-01T00:00:00.000Z", status: "PENDING", version: 1 }] : [] }) }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { ...project, role: "OWNER" }, draft: { id: project.currentDraftId, schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } }) }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
    await page.route(`**/api/projects/${project.id}/settings`, async (route) => {
      const body = route.request().postDataJSON() as { name: string; expectedSettingsVersion: number };
      expect(body.expectedSettingsVersion).toBe(status.settingsVersion);
      status = { ...status, settingsVersion: status.settingsVersion + 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, name: body.name, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/members/${member.profileId}`, async (route) => {
      if (route.request().method() === "DELETE") {
        const body = route.request().postDataJSON() as { expectedMemberVersion: number };
        expect(body.expectedMemberVersion).toBe(member.version);
        removed = true;
        member.version += 1;
        status = { ...status, membershipVersion: status.membershipVersion + 1, designatedApproverId: null, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, profileId: member.profileId, memberVersion: member.version, replayed: false }) });
      }
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON() as { role: string; expectedMemberVersion: number };
      expect(body.expectedMemberVersion).toBe(member.version);
      expect(route.request().headers()["idempotency-key"]).toHaveLength(36);
      member.role = body.role;
      member.version += 1;
      status = { ...status, membershipVersion: status.membershipVersion + 1 };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, profileId: member.profileId, role: member.role, memberVersion: member.version, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(response()) }));
    await page.route(`**/api/projects/${project.id}/approval-policy`, async (route) => {
      const body = route.request().postDataJSON() as { designatedApproverId: string; expectedApprovalPolicyVersion: number };
      expect(body.expectedApprovalPolicyVersion).toBe(status.approvalPolicyVersion);
      status = { ...status, designatedApproverId: body.designatedApproverId, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/archive`, async (route) => {
      const body = route.request().postDataJSON() as { expectedProjectVersion: number; reason: string };
      expect(body.expectedProjectVersion).toBe(status.version);
      expect(body.reason).toBe("Finished pilot work");
      status = { ...status, status: "ARCHIVED", version: status.version + 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, replayed: false }) });
    });

    await page.goto(`/app/projects/${project.id}`);
    const context = page.getByRole("complementary", { name: "Project details" });
    await context.getByRole("button", { name: "Hide right sidebar" }).click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(context).toBeVisible();
    await expect(page.getByLabel("Verified email")).toBeVisible();
    await expect(context.getByText("No pending invitations.")).toBeVisible();
    await context.getByRole("tab", { name: "Details", exact: true }).click();
    showPendingInvite = true;
    await context.getByRole("tab", { name: "Share", exact: true }).click();
    await expect(context.getByText("pending@example.test")).toBeVisible();
    await context.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit project name" })).toBeVisible();
    await page.getByRole("button", { name: "Edit project name" }).click();
    await expect(page.getByLabel("Project name")).toBeFocused();
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    const statusRefresh = page.waitForResponse(`**/api/projects/${project.id}/status`);
    await refresh.click();
    await statusRefresh;
    await expect(refresh).toBeFocused();
    await page.getByLabel("Project name").fill("Discarded management project");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(context.getByRole("tabpanel", { name: "Details" }).getByText("Management project", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit project name" }).click();
    await page.getByLabel("Project name").fill("Renamed management project");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.locator(".workspace-header").getByText("Renamed management project", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(page.getByText("Casey Collaborator", { exact: true })).toBeVisible();
    await page.getByLabel("Role for Casey Collaborator").selectOption("EDITOR");
    await expect(page.getByRole("region", { name: "Project management" }).getByRole("status")).toContainText("Member role updated.");
    await page.getByLabel("Designated approver").selectOption(member.profileId);
    await page.getByRole("button", { name: "Save approver" }).click();
    await expect(page.getByRole("region", { name: "Project management" }).getByRole("status")).toContainText("Approver updated.");
    await page.getByRole("button", { name: "Edit project name" }).click();
    await page.getByLabel("Project name").fill("Unsaved name");
    await page.getByRole("button", { name: "Archive project" }).click();
    await page.getByLabel("Archive reason").fill("Finished pilot work");
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore project" })).toBeVisible();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0);
    await expect(page.getByRole("tabpanel", { name: "Details" }).getByText("Renamed management project", { exact: true })).toBeVisible();
    await page.getByLabel("Role for Casey Collaborator").selectOption("REVIEWER");
    await expect(page.getByRole("button", { name: "Confirm role change" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm role change" }).click();
    await expect(page.getByLabel("Role for Casey Collaborator").locator("option[value=EDITOR]")).toHaveCount(0);
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect(page.getByText("Casey Collaborator", { exact: true })).toHaveCount(0);
  });

  test("a non-owner can inspect members without management controls", async ({ page }) => {
    const status = { status: "ACTIVE", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null };
    await page.route("**/api/workspaces", async (route) => route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Management Test", canCreate: false, maxWorkspaces: 1, ownedCount: 0, workspaces: [{ ...workspace, canManage: false }] }) }) : route.continue());
    await page.route(`**/api/workspaces/${workspace.id}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, canCreateProject: false }, projects: [project] }) }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { ...project, role: "VIEWER" }, draft: { id: project.currentDraftId, schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } }) }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: status, members: [{ profileId: "44444444-4444-4444-8444-444444444444", displayName: "Owner", role: "OWNER", version: 1, designatedApprover: false }] }) }));

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByRole("region", { name: "Project management" }).getByText("Owner", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit project name" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive project" })).toHaveCount(0);
  });
});
