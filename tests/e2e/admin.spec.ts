import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, e2eReady, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true });
const limits = (page: Page) => page.getByRole("region", { name: "Limits" });
const roleSection = (page: Page) => page.getByRole("region", { name: "Role", exact: true });

test.describe("staff screens", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  const token = () => randomUUID().slice(0, 8);

  test.beforeEach(async () => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  /** The first staff rows are seeded in the database, as the operator script does; everything after goes through the screens. */
  async function grant(authUserId: string, role: "ADMIN" | "MODERATOR") {
    await database.query(
      "insert into app.platform_role (profile_id, role, granted_by) select id, $2, id from app.user_profile where auth_user_id = $1::uuid",
      [authUserId, role],
    );
  }

  /** Another account with a profile, optionally with AI usage today. It is never signed in. */
  async function account(name: string, usedToday = 0) {
    const { data, error } = await admin.auth.admin.createUser({ email: `e2e-${randomUUID()}@example.test`, password: `E2e-${randomUUID()}-Pass!`, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    users.push(data.user.id);
    const { rows: [profile] } = await database.query<{ id: string }>("insert into app.user_profile (auth_user_id, display_name) values ($1, $2) returning id", [data.user.id, name]);
    if (usedToday) {
      await database.query("insert into app.ai_owner_allowance (owner_id) values ($1)", [profile!.id]);
      await database.query("insert into app.ai_budget_day (owner_id, day, consumed_runs) values ($1, (now() at time zone 'utc')::date, $2)", [profile!.id, usedToday]);
    }
    return profile!.id;
  }

  async function search(page: Page, term: string) {
    await page.getByLabel("Search by name").fill(term);
    await page.getByRole("button", { name: "Search" }).click();
  }

  test("an Admin searches, opens an account, raises its AI total, sees the history and grants Moderator", async ({ page }) => {
    const me = await signIn(page, admin, users, "Admin Tester");
    await grant(me.authUserId, "ADMIN");
    const word = token();
    const targetName = `Zed Target ${word}`;
    const candidateName = `Zed Candidate ${word}`;
    const targetId = await account(targetName, 2);
    const candidateId = await account(candidateName);

    await page.goto("/app");
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
    await shot(page, "workspace-admin-link");
    await page.getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to projects" })).toHaveAttribute("href", "/app");

    await search(page, `Zed Target ${word}`);
    const row = page.getByRole("row").filter({ hasText: targetName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Default");
    await expect(row).toContainText("2 of");
    await expect(row).toContainText(`${targetId.slice(0, 8)} \u00b7 joined`);
    await shot(page, "admin-accounts");

    await row.getByRole("link", { name: targetName }).click();
    await expect(page).toHaveURL(new RegExp(`/app/admin/accounts/${targetId}$`));
    await expect(page.getByRole("heading", { level: 1, name: targetName })).toBeVisible();
    await expect(page.getByText(`${targetId.slice(0, 8)} \u00b7 joined`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("No changes yet.")).toBeVisible();
    await shot(page, "admin-account-detail");

    const form = limits(page);
    await form.getByLabel("AI total runs", { exact: true }).fill("50");
    await expect(form.getByRole("button", { name: "Save limits" })).toBeDisabled();
    await form.getByLabel("Reason").fill("Pilot extension");
    await expect(form.getByText("15 of 500 characters.")).toBeVisible();
    await form.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    const history = page.getByRole("region", { name: "History" });
    await expect(history).toContainText("Changed limits");
    await expect(history).toContainText("Pilot extension");
    await expect(history).toContainText("AI total 50");
    await expect(page.locator(".admin-summary")).toContainText("2 of 50");
    await shot(page, "admin-account-saved");

    await page.goto(`/app/admin/accounts/${candidateId}`);
    await expect(page.getByRole("heading", { level: 1, name: candidateName })).toBeVisible();
    const roles = roleSection(page);
    await roles.getByRole("combobox", { name: "Role" }).selectOption("MODERATOR");
    await roles.getByLabel("Reason").fill("Joins the support rota");
    await roles.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    await expect(page.locator(".admin-summary")).toContainText("Moderator");
    await expect(page.getByRole("region", { name: "History" })).toContainText("Set role");

    // Staff AI is unlimited, but the limits form starts from the default plan, so saving it never stores an unlimited override.
    await page.reload();
    await expect(limits(page)).toContainText("AI is unlimited while this account has a staff role.");
    await expect(limits(page).getByRole("checkbox", { name: "Unlimited AI total runs" })).not.toBeChecked();
    await expect(limits(page).getByLabel("AI total runs", { exact: true })).toHaveValue("5");
  });

  test("a Moderator edits limits and gets no role editor", async ({ page }) => {
    const me = await signIn(page, admin, users, "Moderator Tester");
    await grant(me.authUserId, "MODERATOR");
    const targetName = `Zed Moderated ${token()}`;
    const targetId = await account(targetName);

    await page.goto("/app");
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
    await page.goto(`/app/admin/accounts/${targetId}`);
    await expect(page.getByRole("heading", { level: 1, name: targetName })).toBeVisible();
    await expect(limits(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Role", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Role" })).toHaveCount(0);

    await limits(page).getByLabel("Max owned projects").fill("7");
    await limits(page).getByLabel("Reason").fill("Larger pilot");
    await limits(page).getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    await expect(page.locator(".admin-summary")).toContainText("0 of 7");
    await expect(page.getByRole("button", { name: "Reset to default plan" })).toBeVisible();
    await shot(page, "admin-moderator-detail");

    // The screen hides the editor; the server refuses the change as well.
    const refused = await page.request.put(`/api/admin/accounts/${targetId}/role`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedVersion: 0, reason: "Not allowed", role: "ADMIN" },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("ADMIN_ROLE_REQUIRED");
  });

  test("a normal account gets the not-found page and no Admin entry", async ({ page }) => {
    await signIn(page, admin, users, "Plain Tester");
    const otherId = await account(`Zed Other ${token()}`);

    const me = page.waitForResponse((response) => response.url().endsWith("/api/me"));
    await page.goto("/app");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(((await (await me).json()) as { platformRole: string | null }).platformRole).toBeNull();
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

    for (const path of ["/app/admin", `/app/admin/accounts/${otherId}`]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
      await expect(page.getByLabel("Search by name")).toHaveCount(0);
    }
    expect((await page.request.get("/api/admin/accounts")).status()).toBe(404);
  });

  test("a version conflict asks for a reload and the reload shows the latest limits", async ({ page }) => {
    const me = await signIn(page, admin, users, "Conflict Tester");
    await grant(me.authUserId, "ADMIN");
    const targetName = `Zed Conflict ${token()}`;
    const targetId = await account(targetName);

    await page.goto(`/app/admin/accounts/${targetId}`);
    await expect(page.getByRole("heading", { level: 1, name: targetName })).toBeVisible();
    await expect(limits(page).getByLabel("Max owned projects")).toBeVisible();

    // Someone else saves first, so the version this page loaded (0) is stale.
    const other = await page.request.patch(`/api/admin/accounts/${targetId}/entitlement`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { expectedVersion: 0, reason: "Concurrent change", maxOwnedProjects: 3, aiTotalRuns: 9, aiDailyRuns: 9, expiresAt: null, blocked: false },
    });
    expect(other.status()).toBe(200);

    await limits(page).getByLabel("AI total runs", { exact: true }).fill("20");
    await limits(page).getByLabel("Reason").fill("My change");
    await limits(page).getByRole("button", { name: "Save limits" }).click();
    await expect(limits(page).getByRole("alert")).toContainText("Someone changed this account. Reload to see the latest.");
    await expect(page.getByRole("status")).toHaveText("");

    await limits(page).getByRole("button", { name: "Reload" }).click();
    await expect(limits(page).getByLabel("AI total runs", { exact: true })).toHaveValue("9");
    await expect(limits(page).getByRole("alert")).toHaveCount(0);
  });

  test("the accounts list and an account fit 320 px without horizontal page scroll", async ({ page }) => {
    const me = await signIn(page, admin, users, "Narrow Tester");
    await grant(me.authUserId, "ADMIN");
    const word = token();
    const targetName = `Zed Narrow ${word} with a long display name that has to wrap`;
    const targetId = await account(targetName, 1);
    await page.setViewportSize({ width: 320, height: 700 });
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto("/app/admin");
    await search(page, `Zed Narrow ${word}`);
    await expect(page.getByRole("link", { name: targetName })).toBeVisible();
    expect(await fits(), "accounts list").toBe(true);
    await shot(page, "admin-accounts-320");

    await page.goto(`/app/admin/accounts/${targetId}`);
    await expect(limits(page)).toBeVisible();
    expect(await fits(), "account detail").toBe(true);
  });
});
