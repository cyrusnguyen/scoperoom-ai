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
    await page.setViewportSize({ width: 1440, height: 900 });
    const archivedRow = page.locator(".workspace-row-wrap");
    const archivedName = archivedRow.locator(".workspace-row > span:first-child");
    expect((await archivedName.boundingBox())!.width).toBeGreaterThan(100);
    await page.setViewportSize({ width: 1100, height: 900 });
    const archivedSelect = archivedRow.locator(".workspace-row");
    const restore = archivedRow.getByRole("button", { name: "Restore workspace Archive workspace" });
    const archivedBadge = archivedRow.getByText("Archived", { exact: true });
    await expect(archivedBadge).toBeVisible();
    await expect(restore).toBeVisible();
    expect((await restore.boundingBox())!.y).toBeGreaterThan((await archivedSelect.boundingBox())!.y);
    expect(await archivedBadge.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(archivedBadge).toBeVisible();
    await expect(restore).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("button", { name: "Restore workspace Archive workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Restore workspace Archive workspace" }).click();
    await expect(page.getByText("Workspace restored.")).toBeVisible();
  });

  test("a restore blocked by the workspace limit opens a focused explanation", async ({ page }) => {
    const archived = { id: workspaceId, name: "Archived limit workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ARCHIVED", version: 4, canManage: true };
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Workspace Archive", canCreate: false, maxWorkspaces: 1, ownedCount: 1, workspaces: [archived] }) });
    });
    await page.route(`**/api/workspaces/${workspaceId}/projects`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspaceId, name: archived.name, canCreateProject: false }, projects: [] }) }));
    await page.route(`**/api/workspaces/${workspaceId}/restore`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "LIMIT_REACHED", message: "Your active workspace limit has been reached." } }) }));

    await page.reload({ waitUntil: "domcontentloaded" });
    const restore = page.getByRole("button", { name: "Restore workspace Archived limit workspace" });
    await restore.click();
    const dialog = page.getByRole("dialog", { name: "Workspace limit reached" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Archive an active workspace, then try restoring this one again.");
    await expect(page.getByText("Your active workspace limit has been reached.")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(restore).toBeFocused();
  });

  test("desktop sidebar widths can be changed with accessible separators and persist for this tab", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const left = page.getByRole("complementary", { name: "Your starting point" });
    const right = page.getByRole("complementary", { name: "Project details" });
    const leftResize = page.getByRole("separator", { name: "Resize workspace sidebar" });
    const rightResize = page.getByRole("separator", { name: "Resize project details sidebar" });

    await expect(leftResize).toBeVisible();
    await expect(rightResize).toBeVisible();
    await page.evaluate(() => { sessionStorage.removeItem("scoperoom_left_width"); sessionStorage.removeItem("scoperoom_right_width"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await left.boundingBox())!.width).toBe(270);
    await expect.poll(async () => (await right.boundingBox())!.width).toBe(290);
    const beforeLeft = (await left.boundingBox())!.width;
    const beforeRight = (await right.boundingBox())!.width;
    await leftResize.focus();
    await page.keyboard.press("ArrowRight");
    await rightResize.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await left.boundingBox())!.width).toBeGreaterThan(beforeLeft);
    await expect.poll(async () => (await right.boundingBox())!.width).toBeGreaterThan(beforeRight);
    await page.setViewportSize({ width: 1100, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1500, height: 900 });
    await right.getByRole("button", { name: "Hide right sidebar" }).click();
    await leftResize.focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await left.boundingBox())!.width).toBe(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.locator(".canvas-toolbar").getByRole("button", { name: "Show right sidebar" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await left.boundingBox())!.width).toBeGreaterThan(beforeLeft);
    expect((await right.boundingBox())!.width).toBeGreaterThan(beforeRight);
});

  test("shows the quota dialog when its follow-up workspace refresh fails", async ({ page }) => {
    const archived = { id: workspaceId, name: "Archived limit workspace", createdAt: "2026-09-25T00:00:00.000Z", status: "ARCHIVED", version: 4, canManage: true };
    let workspaceReads = 0;
    await page.route("**/api/workspaces", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      workspaceReads += 1;
      return workspaceReads === 2
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Could not refresh workspaces." } }) })
        : route.fulfill({ contentType: "application/json", body: JSON.stringify({ displayName: "Workspace Archive", canCreate: false, maxWorkspaces: 1, ownedCount: 1, workspaces: [archived] }) });
    });
    await page.route("**/api/workspaces/" + workspaceId + "/projects", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace: { id: workspaceId, name: archived.name, canCreateProject: false }, projects: [] }) }));
    await page.route("**/api/workspaces/" + workspaceId + "/restore", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "LIMIT_REACHED", message: "Your active workspace limit has been reached." } }) }));
    await page.goto("/");
    const restore = page.getByRole("button", { name: "Restore workspace Archived limit workspace" });
    await restore.click();
    const dialog = page.getByRole("dialog", { name: "Workspace limit reached" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Archive an active workspace, then try restoring this one again.");
    await expect(page.getByText("Could not refresh workspaces.")).toBeVisible();
    await expect(page.getByText("Your active workspace limit has been reached.")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: "Refresh workspaces" })).toBeFocused();
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(page.getByText("No projects yet.")).toBeVisible();
  });
});
