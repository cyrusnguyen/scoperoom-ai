import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const workspaceId = "11111111-1111-4111-8111-111111111111";

test.skip(!authUrl || !secretKey || !databaseUrl, "Requires isolated local Supabase Auth and database URLs");

test.describe("workspace archive", () => {
  let admin: SupabaseClient;
  let database: Client;
  let authUserId = "";

  test.beforeEach(async ({ page }) => {
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    database = new Client({ connectionString: databaseUrl! });
    await database.connect();
    const email = `workspace-archive-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: "Workspace-archive-pass-1", email_confirm: true, user_metadata: { full_name: "Workspace Archive" } });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    authUserId = data.user.id;
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("Workspace-archive-pass-1");
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

  test("an owner archives and restores a visible workspace", async ({ page }) => {
    let workspace = { id: workspaceId, name: "Archive workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ACTIVE", version: 1, canManage: true };
    const archiveKeys: string[] = [];
    let uncertain = true;
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Workspace Archive", canCreate: true, maxWorkspaces: 1, ownedCount: workspace.status === "ACTIVE" ? 1 : 0, workspaces: [workspace] }) });
    });
    await page.route(`**/api/workspaces/${workspaceId}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspaceId, name: workspace.name, canCreateProject: workspace.status === "ACTIVE" }, projects: [] }) }));
    await page.route(`**/api/workspaces/${workspaceId}/archive`, async (route) => {
      archiveKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (uncertain) { uncertain = false; await route.abort("failed"); return; }
      expect((route.request().postDataJSON() as { expectedVersion: number }).expectedVersion).toBe(1);
      workspace = { ...workspace, status: "ARCHIVED", version: 2 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...workspace, replayed: false }) });
    });
    await page.route(`**/api/workspaces/${workspaceId}/restore`, async (route) => {
      expect((route.request().postDataJSON() as { expectedVersion: number }).expectedVersion).toBe(2);
      workspace = { ...workspace, status: "ACTIVE", version: 3 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...workspace, replayed: false }) });
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Archive workspace Archive workspace" }).click();
    await page.getByRole("button", { name: "Confirm archive workspace" }).click();
    await expect(page.getByText("We could not confirm that workspace change. Retry uses the same request.")).toBeVisible();
    await page.getByRole("button", { name: "Retry workspace change" }).click();
    expect(archiveKeys).toHaveLength(2);
    expect(archiveKeys[1]).toBe(archiveKeys[0]);
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore workspace Archive workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Restore workspace Archive workspace" }).click();
    await expect(page.getByText("Workspace restored.")).toBeVisible();
  });
});
