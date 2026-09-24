import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Route } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const password = `Workspace-${randomUUID()}-Pass!`;

test("workspace APIs deny direct anonymous requests", async ({ request }) => {
  for (const path of ["/api/me", "/api/workspaces"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});

test("workspace creation rejects an anonymous POST", async ({ request }) => {
  const response = await request.post("/api/workspaces", {
    headers: { Origin: "http://127.0.0.1:3101", "Idempotency-Key": "a".repeat(16) },
    data: { name: "Denied workspace" },
  });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
});

test.describe("workspace admission", () => {
  test.skip(!authUrl || !secretKey || !databaseUrl, "Requires local Supabase Auth and migration database URLs");

  let admin: SupabaseClient;
  let database: Client;
  let authUserId: string;
  let email: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    database = new Client({ connectionString: databaseUrl! });
    await database.connect();
    email = `workspace-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Workspace Test" },
    });
    if (error || !data.user) throw error ?? new Error("Test user was not created.");
    authUserId = data.user.id;
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByText("Workspace creation is not available for this account.")).toBeVisible();
  });

  test.afterEach(async () => {
    if (!database || !authUserId) return;
    const profile = await database.query<{ id: string }>(
      "select id from app.user_profile where auth_user_id = $1",
      [authUserId],
    );
    if (profile.rows[0]) {
      const profileId = profile.rows[0].id;
      await database.query("delete from app.mutation_receipt where actor_id = $1", [profileId]);
      await database.query("delete from app.workspace where owner_id = $1", [profileId]);
      await database.query("delete from app.pilot_entitlement where profile_id = $1", [profileId]);
      await database.query("delete from app.user_profile where id = $1", [profileId]);
    }
    await database.end();
    await admin.auth.admin.deleteUser(authUserId);
  });

  async function grantOneWorkspace() {
    const profile = await database.query<{ id: string }>(
      "select id from app.user_profile where auth_user_id = $1",
      [authUserId],
    );
    if (!profile.rows[0]) throw new Error("Workspace home did not create the test profile.");
    await database.query(
      "insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())",
      [profile.rows[0].id],
    );
  }

  test("sidebar controls hide, restore, and remember both panels", async ({ page }) => {
    const left = page.getByRole("complementary", { name: "Your starting point" });
    const right = page.getByRole("complementary", { name: "Project details" });
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    const leftClose = left.getByRole("button", { name: "Hide left sidebar" });
    const rightClose = right.getByRole("button", { name: "Hide right sidebar" });
    await expect(leftClose.locator("svg")).toBeVisible();
    await expect(rightClose.locator("svg")).toBeVisible();
    const leftBox = (await left.boundingBox())!;
    const rightBox = (await right.boundingBox())!;
    const leftCloseBox = (await leftClose.boundingBox())!;
    const rightCloseBox = (await rightClose.boundingBox())!;
    expect(leftCloseBox.x + leftCloseBox.width).toBeGreaterThan(leftBox.x + leftBox.width - 48);
    expect(rightCloseBox.x).toBeLessThan(rightBox.x + 48);
    expect((await left.getByText("WORKSPACE", { exact: true }).boundingBox())!.y).toBeGreaterThan(leftCloseBox.y + leftCloseBox.height);
    expect((await right.getByText("CONTEXT", { exact: true }).boundingBox())!.y).toBeGreaterThan(rightCloseBox.y + rightCloseBox.height);
    await leftClose.click();
    await expect(left).toBeHidden();
    await expect(right).toBeVisible();
    const toolbar = page.locator(".canvas-toolbar");
    await expect(toolbar.getByRole("button", { name: "Show left sidebar" })).toBeFocused();
    await toolbar.getByRole("button", { name: "Show left sidebar" }).click();
    await expect(left).toBeVisible();
    await expect(leftClose).toBeFocused();
    await rightClose.focus();
    await page.keyboard.press("Enter");
    await expect(right).toBeHidden();
    await expect(toolbar.getByRole("button", { name: "Show right sidebar" })).toBeFocused();
    await toolbar.getByRole("button", { name: "Show right sidebar" }).click();
    await expect(right).toBeVisible();
    await expect(rightClose).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await left.getByRole("button", { name: "Hide left sidebar" }).click();
    await expect(left).toBeHidden();
    await toolbar.getByRole("button", { name: "Show left sidebar" }).click();
    await expect(left).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await left.getByRole("button", { name: "Hide left sidebar" }).click();
    await right.getByRole("button", { name: "Hide right sidebar" }).click();
    expect(await page.evaluate(() => [sessionStorage.getItem("scoperoom_left_open"), sessionStorage.getItem("scoperoom_right_open")])).toEqual(["0", "0"]);
    const preferenceCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "scoperoom_left_open" || cookie.name === "scoperoom_right_open");
    expect(preferenceCookies).toHaveLength(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(left).toBeHidden();
    await expect(right).toBeHidden();
    await toolbar.getByRole("button", { name: "Show left sidebar" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(left).toBeVisible();
    await expect(right).toBeHidden();
  });

  test("a non-entitled member sees no creation control", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("Workspace creation is not available for this account.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create workspace" })).toHaveCount(0);
  });

  test("an entitled member creates, lists, and refreshes a workspace", async ({ page }) => {
    await grantOneWorkspace();
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(page.getByRole("button", { name: "Create workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByLabel("Workspace name").fill("Browser workspace");
    await page.getByRole("button", { name: "Create workspace" }).last().click();
    await expect(page.getByText("Browser workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Workspace created");
    await expect(page.getByText("1 of 1 owned workspaces")).toBeVisible();
    await expect(page.getByText("Your workspace limit has been reached.")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("a failed refresh after creation shows both the confirmation and the read error", async ({ page }) => {
    await grantOneWorkspace();
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByLabel("Workspace name").fill("Created before refresh failed");
    await page.route("**/api/workspaces", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Workspace access is unavailable." } }) });
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Create workspace" }).last().click();
    await expect(page.getByRole("status")).toContainText("Workspace created. Workspace access is unavailable.");
    await expect(page.getByRole("list", { name: "Your workspaces" })).toHaveCount(0);
  });
  test("failed refresh hides stale workspace data and recovers", async ({ page }) => {
    await grantOneWorkspace();
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(page.getByRole("button", { name: "Create workspace" })).toBeVisible();
    const unavailable = async (route: Route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Workspace access is unavailable." } }) });
    await page.route("**/api/workspaces", unavailable);
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(page.getByRole("button", { name: "Create workspace" })).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Workspace access is unavailable.");
    await page.unroute("**/api/workspaces", unavailable);
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(page.getByRole("button", { name: "Create workspace" })).toBeVisible();
  });
  test("an uncertain create retries the same key without a duplicate workspace", async ({ page }) => {
    await grantOneWorkspace();
    await page.getByRole("button", { name: "Refresh workspaces" }).click();
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByLabel("Workspace name").fill("Retry workspace");
    const keys: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/workspaces") && request.method() === "POST") {
        keys.push(request.headers()["idempotency-key"] ?? "");
      }
    });
    const dropResponse = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      await route.abort("failed");
    };
    await page.route("**/api/workspaces", dropResponse);
    await page.getByRole("button", { name: "Create workspace" }).last().click();
    await expect(page.getByLabel("Workspace name")).toHaveValue("Retry workspace");
    await expect(page.getByLabel("Workspace name")).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("We could not confirm workspace creation");
    await page.unroute("**/api/workspaces", dropResponse);
    await page.getByRole("button", { name: "Retry workspace creation" }).click();
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    await expect(page.getByRole("status")).toContainText("Workspace already created.");
    await expect(page.getByRole("list", { name: "Your workspaces" }).getByRole("listitem")).toHaveCount(1);
  });
});





