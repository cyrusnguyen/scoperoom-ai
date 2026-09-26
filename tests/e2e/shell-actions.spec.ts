import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const ids = { alpha: "11111111-1111-4111-8111-111111111111", beta: "22222222-2222-4222-8222-222222222222" };
const item = (id: string, name: string, status = "ACTIVE") => ({ id, name, status, role: "OWNER", ownerName: "Actions Owner", updatedAt: "2026-09-26T00:00:00.000Z" });
const group = (items: unknown[] = []) => ({ items, truncated: false });
const capacity = (activeOwned: number, maxOwned: number) => ({ entitled: true, activeOwned, maxOwned, canCreate: activeOwned < maxOwned });
const noInvites = { items: [], truncated: false };
const envelope = (code: string, message: string) => ({ error: { code, message, requestId: "00000000-0000-4000-8000-000000000000", retryable: false } });
const status = (version: number, state = "ACTIVE") => ({
  status: state, version, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null,
  currentDraftId: "55555555-5555-4555-8555-555555555555", documentRevision: 1, layoutRevision: 1, realtimeEpoch: "88888888-8888-4888-8888-888888888888", eventSequence: 1,
});
const sidebar = (page: Page) => page.locator("#projects-nav");
const notice = (page: Page) => page.locator(".app-footer").getByRole("status");

test.describe("shell actions", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async () => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
  });

  test.afterEach(async () => {
    try { await cleanupUsers(database, admin, users); } finally { await database.end(); }
  });

  test("row menus archive with a reason and restore within capacity, and the sidebar refreshes from the server", async ({ page }) => {
    await signIn(page, admin, users, "Actions Test");
    let state: "active" | "archived" | "restored" = "active";
    let maxOwned = 2;
    const alpha = item(ids.alpha, "Alpha plan");
    const beta = item(ids.beta, "Beta notes");
    await page.route("**/api/projects", (route) => route.fulfill({ json: state === "archived"
      ? { owned: group([beta]), shared: group(), archived: group([{ ...alpha, status: "ARCHIVED" }]), capacity: capacity(1, maxOwned) }
      : { owned: group([alpha, beta]), shared: group(), archived: group(), capacity: capacity(2, maxOwned) } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: noInvites }));
    await page.route(`**/api/projects/${ids.alpha}/status`, (route) => route.fulfill({ json: state === "archived" ? status(2, "ARCHIVED") : status(state === "active" ? 1 : 3) }));
    await page.route(`**/api/projects/${ids.alpha}/archive`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedProjectVersion: 1, reason: "Pilot finished" });
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      state = "archived";
      await route.fulfill({ json: { ...status(2, "ARCHIVED"), replayed: false } });
    });
    await page.route(`**/api/projects/${ids.alpha}/restore`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedProjectVersion: 2 });
      state = "restored";
      await route.fulfill({ json: { ...status(3), replayed: false } });
    });

    await page.goto("/app");
    const nav = sidebar(page);
    await nav.getByRole("button", { name: "Actions for Alpha plan" }).click();
    await expect(page.getByRole("menuitem", { name: "Archive…" })).toBeFocused();
    await page.keyboard.press("Enter");
    const archive = page.getByRole("dialog", { name: "Archive Alpha plan?" });
    await expect(archive.getByLabel("Reason")).toBeFocused();
    await archive.getByLabel("Reason").fill("Pilot finished");
    await archive.getByRole("button", { name: "Archive" }).click();
    await expect(archive).toHaveCount(0);
    await expect(notice(page)).toHaveText("Archived Alpha plan.");
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toHaveCount(0);

    await nav.getByRole("tab", { name: "Archived projects" }).click();
    maxOwned = 1;
    await page.reload();
    await nav.getByRole("button", { name: "Actions for Alpha plan" }).click();
    await expect(page.getByRole("menuitem", { name: "Restore — at limit (1/1)" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Actions for Alpha plan" })).toBeFocused();

    maxOwned = 2;
    await page.reload();
    await nav.getByRole("button", { name: "Actions for Alpha plan" }).click();
    await nav.getByRole("menuitem", { name: "Restore…" }).click();
    const restore = page.getByRole("dialog", { name: "Restore Alpha plan?" });
    await expect(restore.getByRole("button", { name: "Cancel" })).toBeFocused();
    await restore.getByRole("button", { name: "Restore" }).click();
    await expect(notice(page)).toHaveText("Restored Alpha plan.");
    await nav.getByRole("tab", { name: "Owned projects" }).click();
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toBeVisible();
  });

  test("a session that ends while the archive dialog reads its preview sends the browser to sign-in", async ({ page, context }) => {
    const owner = await signIn(page, admin, users, "Actions Test");
    await entitle(database, owner.authUserId);
    await createProjectViaApi(page, "Session end project");
    await page.goto("/app");
    const nav = sidebar(page);
    await nav.getByRole("button", { name: "Actions for Session end project" }).click();
    // Clearing cookies here (not before the menu opens) simulates the session ending between opening
    // the row menu and the dialog's status read, without a page navigation that would mask the effect.
    await context.clearCookies();
    await page.getByRole("menuitem", { name: "Archive…" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a version conflict keeps the archive dialog open and requires a fresh preview", async ({ page }) => {
    await signIn(page, admin, users, "Actions Test");
    let serverVersion = 1;
    const sent: number[] = [];
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: group([item(ids.alpha, "Alpha plan")]), shared: group(), archived: group(), capacity: capacity(1, 10) } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: noInvites }));
    await page.route(`**/api/projects/${ids.alpha}/status`, (route) => route.fulfill({ json: status(serverVersion) }));
    await page.route(`**/api/projects/${ids.alpha}/archive`, async (route) => {
      const { expectedProjectVersion } = route.request().postDataJSON() as { expectedProjectVersion: number };
      sent.push(expectedProjectVersion);
      if (expectedProjectVersion !== serverVersion) return route.fulfill({ status: 409, json: envelope("CONFLICT", "That change conflicts with current data. Refresh and try again.") });
      await route.fulfill({ json: { ...status(serverVersion + 1, "ARCHIVED"), replayed: false } });
    });
    await page.goto("/app");
    await sidebar(page).getByRole("button", { name: "Actions for Alpha plan" }).click();
    await page.getByRole("menuitem", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive Alpha plan?" });
    await dialog.getByLabel("Reason").fill("Pilot finished");
    await expect(dialog.getByRole("button", { name: "Archive" })).toBeEnabled();
    serverVersion = 4; // another tab changed the project after this dialog's preview
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("That change conflicts with current data. Refresh and try again.");
    await expect(dialog.getByLabel("Reason")).toHaveValue("Pilot finished");
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([1, 4]);
  });

  test("accepting an invitation reports a full project inline and drops one that is gone", async ({ page }) => {
    await signIn(page, admin, users, "Actions Test");
    const full = { id: "66666666-6666-4666-8666-666666666666", projectName: "Delta field app", inviterName: "Mei Tan", role: "VIEWER", expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString() };
    const gone = { id: "77777777-7777-4777-8777-777777777777", projectName: "Old kiosk", inviterName: "Priya Nair", role: "EDITOR", expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    let items = [full, gone];
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: group(), shared: group(), archived: group(), capacity: capacity(0, 10) } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items, truncated: false } }));
    await page.route("**/api/invitations/accept", async (route) => {
      const { invitationId } = route.request().postDataJSON() as { invitationId: string };
      if (invitationId === full.id) return route.fulfill({ status: 422, json: envelope("COLLABORATOR_LIMIT", "This project is full (10 collaborators including the owner).") });
      items = [full];
      await route.fulfill({ status: 404, json: envelope("NOT_FOUND", "This project or invitation is unavailable.") });
    });
    await page.goto("/app");
    const nav = sidebar(page);
    await nav.getByRole("tab", { name: "Invitations, 2 pending" }).click();
    await expect(nav.getByText("Expires today")).toBeVisible();
    await nav.getByRole("button", { name: "Accept Delta field app" }).click();
    await expect(nav.getByRole("alert")).toHaveText("This project is full (10 collaborators including the owner).");
    await nav.getByRole("button", { name: "Accept Old kiosk" }).click();
    await expect(notice(page)).toHaveText("This invitation is no longer available.");
    await expect(nav.getByText("Old kiosk")).toHaveCount(0);
    await expect(nav.getByRole("tab", { name: "Invitations, 1 pending" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/app$/);
  });

  test("an invited member accepts from Invites, then leaves the project after the owner archives it", async ({ page, browser }) => {
    test.setTimeout(90_000);
    const owner = await signIn(page, admin, users, "Shell Owner");
    await entitle(database, owner.authUserId);
    const projectId = await createProjectViaApi(page, "Shared shell project");
    const memberContext = await browser.newContext({ baseURL: appUrl });
    try {
      const memberPage = await memberContext.newPage();
      const member = await signIn(memberPage, admin, users, "Shell Member");
      const issued = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { verifiedEmail: member.email, role: "REVIEWER" } });
      expect(issued.status()).toBe(201);

      await memberPage.reload();
      const nav = sidebar(memberPage);
      await nav.getByRole("tab", { name: "Invitations, 1 pending" }).click();
      await expect(nav.getByText(/From Shell Owner · Reviewer · Expires/)).toBeVisible();
      await nav.getByRole("button", { name: "Accept Shared shell project" }).click();
      await expect(notice(memberPage)).toHaveText("Joined Shared shell project as Reviewer.");
      await expect(nav.getByRole("tab", { name: "Invitations, 0 pending" })).toHaveAttribute("aria-selected", "true");
      await expect(memberPage).toHaveURL(/\/app$/);
      await nav.getByRole("tab", { name: "Shared with me" }).click();
      await nav.getByRole("button", { name: /^Shared shell project/ }).click();
      await expect(memberPage.getByRole("heading", { level: 1, name: "Shared shell project" })).toBeVisible();

      const current = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { version: number };
      const archived = await page.request.post(`/api/projects/${projectId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: current.version, reason: "Shell test archive" } });
      expect(archived.status()).toBe(200);

      await memberPage.reload();
      await expect(memberPage.getByText("Archived · read-only")).toBeVisible();
      await expect(memberPage.getByRole("button", { name: "Restore…" })).toHaveCount(0);
      await nav.getByRole("tab", { name: "Archived projects" }).click();
      await nav.getByRole("button", { name: "Actions for Shared shell project" }).click();
      await memberPage.getByRole("menuitem", { name: "Leave…" }).click();
      const dialog = memberPage.getByRole("dialog", { name: "Leave Shared shell project?" });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.getByRole("button", { name: "Leave", exact: true }).click();
      await expect(notice(memberPage)).toHaveText("Left Shared shell project.");
      await expect(memberPage).toHaveURL(/\/app$/);
      await expect(memberPage.getByRole("heading", { level: 1, name: "No project open" })).toBeVisible();
      await expect(nav.getByText("No archived projects.")).toBeVisible();
      expect((await memberPage.request.get(`/api/projects/${projectId}/bootstrap`)).status()).toBe(404);
    } finally {
      await memberContext.close();
    }
  });
});
