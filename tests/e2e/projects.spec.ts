import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Route } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const password = `Project-${randomUUID()}-Pass!`;
const workspace = { id: "11111111-1111-4111-8111-111111111111", name: "Browser workspace", createdAt: "2026-09-25T00:00:00.000Z" };
const secondWorkspace = { id: "44444444-4444-4444-8444-444444444444", name: "Second workspace", createdAt: "2026-09-25T00:00:00.000Z" };
const project = { id: "22222222-2222-4222-8222-222222222222", workspaceId: workspace.id, name: "Browser project", status: "ACTIVE", currentDraftId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-09-25T00:00:00.000Z" };

test.describe("project shell", () => {
  test.skip(!authUrl || !secretKey || !databaseUrl, "Requires local Supabase Auth and migration database URLs");

  let admin: SupabaseClient;
  let database: Client;
  let authUserId: string;

  test.beforeEach(async ({ page }) => {
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    database = new Client({ connectionString: databaseUrl! });
    await database.connect();
    const email = `project-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Project Test" },
    });
    if (error || !data.user) throw error ?? new Error("Test user was not created.");
    authUserId = data.user.id;

    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test.afterEach(async () => {
    if (database && authUserId) {
      await database.query("delete from app.user_profile where auth_user_id = $1", [authUserId]);
      await database.end();
    }
    if (authUserId) await admin.auth.admin.deleteUser(authUserId);
  });

  test("creates, opens, reloads, and clears unavailable project details", async ({ page }) => {
    let listedProjects: typeof project[] = [];
    let bootstrapAvailable = true;
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Project Test", canCreate: true, maxWorkspaces: 1, ownedCount: 1, workspaces: [workspace] }) });
    });
    await page.route(`**/api/workspaces/${workspace.id}/projects`, async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, canCreateProject: true }, projects: listedProjects }) });
    });
    await page.route("**/api/projects", async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      listedProjects = [project];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: project.id, workspaceId: workspace.id, name: project.name, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/bootstrap`, async (route) => {
      if (!bootstrapAvailable) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Project is unavailable." } }) });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { id: project.id, workspaceId: workspace.id, name: project.name, status: "ACTIVE", role: "OWNER" }, draft: { id: project.currentDraftId, schemaVersion: 3, documentRevision: 1, layoutRevision: 1, documentJson: { version: 3, nodes: {}, edges: {}, groups: {}, metadata: {} }, layoutJson: { version: 1, nodes: {} } } }) });
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Browser workspace" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill(project.name);
    await page.getByRole("button", { name: "Create project" }).last().click();
    await expect(page).toHaveURL(`/app/projects/${project.id}`);
    const projectContext = page.getByRole("complementary", { name: "Project details" });
    await expect(projectContext.getByRole("heading", { name: project.name })).toBeVisible();
    await expect(projectContext.getByText("Owner", { exact: true })).toBeVisible();
    await expect(projectContext.getByText("Empty draft", { exact: true })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    bootstrapAvailable = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    const context = page.getByRole("complementary", { name: "Project details" });
    await expect(context.getByText(project.name, { exact: true })).toHaveCount(0);
    await expect(context.getByText("Project details are unavailable.")).toBeVisible();
  });
  test("ignores a late project-list response from a previously selected workspace", async ({ page }) => {
    let releaseFirstList: () => void;
    let firstListResponded = false;
    const firstListGate = new Promise<void>((resolve) => { releaseFirstList = resolve; });
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Project Test", canCreate: true, maxWorkspaces: 2, ownedCount: 2, workspaces: [workspace, secondWorkspace] }) });
    });
    await page.route(`**/api/workspaces/${workspace.id}/projects`, async (route) => {
      await firstListGate;
      firstListResponded = true;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, canCreateProject: true }, projects: [{ ...project, name: "First project" }] }) });
    });
    await page.route(`**/api/workspaces/${secondWorkspace.id}/projects`, async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: secondWorkspace.id, name: secondWorkspace.name, canCreateProject: false }, projects: [{ ...project, id: "55555555-5555-4555-8555-555555555555", name: "Second project" }] }) });
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Browser workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Second workspace" }).click();
    await expect(page.getByText("Second project", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);

    releaseFirstList!();
    await expect.poll(() => firstListResponded).toBe(true);
    await expect(page.getByText("First project", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Second project", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
  });
  test("keeps an uncertain project retry on its original workspace", async ({ page }) => {
    const attempts: string[] = [];
    const dropCreate = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push((route.request().postDataJSON() as { workspaceId: string }).workspaceId);
      await route.abort("failed");
    };
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Project Test", canCreate: true, maxWorkspaces: 2, ownedCount: 2, workspaces: [workspace, secondWorkspace] }) });
    });
    await page.route(`**/api/workspaces/${workspace.id}/projects`, async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, canCreateProject: true }, projects: [] }) });
    });
    await page.route(`**/api/workspaces/${secondWorkspace.id}/projects`, async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: secondWorkspace.id, name: secondWorkspace.name, canCreateProject: true }, projects: [] }) });
    });
    await page.route("**/api/projects", dropCreate);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill("Retry target");
    await page.getByRole("button", { name: "Create project" }).last().click();
    await expect(page.getByRole("button", { name: "Retry project creation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Second workspace" })).toBeDisabled();

    await page.unroute("**/api/projects", dropCreate);
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push((route.request().postDataJSON() as { workspaceId: string }).workspaceId);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: project.id, workspaceId: workspace.id, name: "Retry target", replayed: true }) });
    });
    await page.getByRole("button", { name: "Retry project creation" }).click();
    await expect.poll(() => attempts).toEqual([workspace.id, workspace.id]);
  });
});
