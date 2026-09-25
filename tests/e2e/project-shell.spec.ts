import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const firstWorkspace = { id: "11111111-1111-4111-8111-111111111111", name: "First workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ACTIVE", version: 1, canManage: true };
const secondWorkspace = { id: "22222222-2222-4222-8222-222222222222", name: "Second workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ACTIVE", version: 1, canManage: true };
const firstProject = { id: "33333333-3333-4333-8333-333333333333", workspaceId: firstWorkspace.id, name: "First project", status: "ACTIVE", currentDraftId: "44444444-4444-4444-8444-444444444444", createdAt: "2026-09-25T00:00:00.000Z" };

test.describe("in-shell project navigation", () => {
  test.skip(!authUrl || !secretKey || !databaseUrl, "Requires local Supabase Auth and migration database URLs");
  let admin: SupabaseClient;
  let database: Client;
  let authUserId = "";

  test.beforeEach(async ({ page }) => {
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    database = new Client({ connectionString: databaseUrl! });
    await database.connect();
    const email = `shell-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: "Project-shell-pass-1", email_confirm: true, user_metadata: { full_name: "Project Shell" } });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    authUserId = data.user.id;
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("Project-shell-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test.afterEach(async () => {
    if (authUserId) {
      await database.query("delete from app.user_profile where auth_user_id = $1", [authUserId]);
      await admin.auth.admin.deleteUser(authUserId);
    }
    await database.end();
  });

  test("selects, creates, and revisits projects without a document reload", async ({ page }) => {
    let releaseFirstBootstrap!: () => void;
    let firstProjects = [firstProject];
    const firstBootstrap = new Promise<void>((resolve) => { releaseFirstBootstrap = resolve; });
    let documentRequests = 0;
    page.on("request", (request) => { if (request.resourceType() === "document" && request.url().includes("/app/projects/")) documentRequests += 1; });
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Project Shell", canCreate: true, maxWorkspaces: 2, ownedCount: 2, workspaces: [firstWorkspace, secondWorkspace] }) });
    });
    await page.route(`**/api/workspaces/${firstWorkspace.id}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { ...firstWorkspace, canCreateProject: true }, projects: firstProjects }) }));
    await page.route(`**/api/workspaces/${secondWorkspace.id}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { ...secondWorkspace, canCreateProject: true }, projects: [] }) }));
    await page.route(`**/api/projects/${firstProject.id}/bootstrap`, async (route) => { await firstBootstrap; await route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { id: firstProject.id, workspaceId: firstWorkspace.id, name: firstProject.name, status: "ACTIVE", role: "OWNER" }, draft: { id: firstProject.currentDraftId, schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } }) }); });
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      firstProjects = [...firstProjects, { ...firstProject, id: "55555555-5555-4555-8555-555555555555", name: "Created in shell" }];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "55555555-5555-4555-8555-555555555555", workspaceId: firstWorkspace.id, name: "Created in shell" }) });
    });
    await page.route("**/api/projects/55555555-5555-4555-8555-555555555555/bootstrap", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { id: "55555555-5555-4555-8555-555555555555", workspaceId: firstWorkspace.id, name: "Created in shell", status: "ACTIVE", role: "OWNER" }, draft: { id: "66666666-6666-4666-8666-666666666666", schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } }) }));

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Loading workspaces")).toBeHidden();
    const firstWorkspaceTree = page.getByRole("list", { name: "Your workspaces" }).getByRole("listitem").filter({ has: page.getByRole("button", { name: "First workspace", exact: true }) });
    await expect(firstWorkspaceTree.getByRole("button", { name: "First project" })).toBeVisible();
    await page.getByRole("button", { name: "First project" }).click();
    await expect(page.getByRole("region", { name: "Canvas" })).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(`/app/projects/${firstProject.id}`);
    await page.getByRole("button", { name: "First workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "First project" }).click();
    await page.getByRole("button", { name: "Second workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    releaseFirstBootstrap();
    await expect(page.getByText("First project", { exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(`/app/projects/${firstProject.id}`);
    await expect(page.getByRole("heading", { name: firstProject.name })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "First workspace", exact: true }).click();
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill("Created in shell");
    await page.getByRole("button", { name: "Create project" }).last().click();
    await expect(page).toHaveURL("/app/projects/55555555-5555-4555-8555-555555555555");
    await expect(page.getByRole("button", { name: "Created in shell" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Canvas" })).toHaveAttribute("aria-busy", "false");
    expect(documentRequests).toBe(0);
  });
});