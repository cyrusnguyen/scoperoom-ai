import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, cleanupUsers, e2eReady, emptyDraftView, openDatabase, signIn, withStatus } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const ids = { alpha: "11111111-1111-4111-8111-111111111111", beta: "22222222-2222-4222-8222-222222222222", coral: "33333333-3333-4333-8333-333333333333", long: "44444444-4444-4444-8444-444444444444" };
const longName = `A very long project name ${"that keeps going ".repeat(6)}`.slice(0, 120);
const item = (id: string, name: string, role = "OWNER", ownerName = "Shell Owner", status = "ACTIVE") => ({ id, name, status, role, ownerName, updatedAt: "2026-09-26T00:00:00.000Z" });
const group = (items: unknown[] = [], truncated = false) => ({ items, truncated });
const capacity = (activeOwned: number, maxOwned: number, entitled = true) => ({ entitled, activeOwned, maxOwned, canCreate: entitled && activeOwned < maxOwned });
const defaultLists = {
  owned: group([item(ids.alpha, "Alpha plan"), item(ids.beta, "Beta notes"), item(ids.long, longName)]),
  shared: group([item(ids.coral, "Coral review", "EDITOR", "Priya Nair")], true),
  archived: group(),
  capacity: capacity(3, 10),
};
const noInvites = { items: [], truncated: false };
const envelope = (code: string, message: string) => ({ error: { code, message, requestId: "00000000-0000-4000-8000-000000000000", retryable: false } });
function bootstrap(id: string, name: string, role = "OWNER") {
  return withStatus({ project: { id, name, status: "ACTIVE", role, ownerId: ids.alpha }, draft: emptyDraftView() });
}

async function mockShell(page: Page, lists: unknown = defaultLists, invitations: unknown = noInvites) {
  await page.route("**/api/projects", (route) => route.fulfill({ json: lists }));
  await page.route("**/api/invitations", (route) => route.fulfill({ json: invitations }));
  for (const [id, name, role] of [[ids.alpha, "Alpha plan", "OWNER"], [ids.beta, "Beta notes", "OWNER"], [ids.coral, "Coral review", "EDITOR"], [ids.long, longName, "OWNER"]] as const) {
    await page.route(`**/api/projects/${id}/bootstrap`, (route) => route.fulfill({ json: bootstrap(id, name, role) }));
  }
}

// The sidebar and right panel change role to "dialog" when they overlay, so tests find them by id.
const sidebar = (page: Page) => page.locator("#projects-nav");
const editorWidth = (page: Page) => page.locator("#editor-main").evaluate((element) => Math.round(element.getBoundingClientRect().width));
const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe("project shell", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Shell Test");
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("sidebar tabs are keyboard operable, the filter narrows only the visible list, and tabs never change the open project", async ({ page }) => {
    await mockShell(page);
    await page.goto(`/app/projects/${ids.alpha}`);
    const title = page.getByRole("heading", { level: 1, name: "Alpha plan" });
    await expect(title).toBeVisible();
    const nav = sidebar(page);
    await expect(nav.getByText("3 of 10 active")).toBeVisible();
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toHaveAttribute("aria-current", "true");

    await nav.getByLabel("Filter owned projects").fill("BETA");
    await expect(nav.getByRole("button", { name: "Beta notes", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toHaveCount(0);
    await nav.getByLabel("Filter owned projects").fill("zzz");
    await expect(nav.getByText("No matches for “zzz”.")).toBeVisible();
    await nav.getByRole("button", { name: "Clear" }).click();
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toBeVisible();

    const owned = nav.getByRole("tab", { name: "Owned projects" });
    await owned.focus();
    await page.keyboard.press("ArrowRight");
    const shared = nav.getByRole("tab", { name: "Shared with me" });
    await expect(shared).toBeFocused();
    await expect(shared).toHaveAttribute("aria-selected", "true");
    expect(await shared.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await expect(nav.getByLabel("Filter shared projects")).toHaveValue("");
    await expect(nav.getByText("Priya Nair · Editor")).toBeVisible();
    await expect(nav.getByText("Showing the first 100. Use Filter to narrow.")).toBeVisible();
    await page.keyboard.press("End");
    await expect(nav.getByRole("tab", { name: "Invites, 0 pending" })).toHaveAttribute("aria-selected", "true");
    await expect(nav.getByText("No pending invitations.")).toBeVisible();
    await page.keyboard.press("Home");
    await expect(owned).toHaveAttribute("aria-selected", "true");
    await expect(title).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${ids.alpha}$`));
  });

  test("capacity text and creation come only from the server's capacity", async ({ page }) => {
    let lists: unknown = { ...defaultLists, capacity: capacity(0, 0, false) };
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await page.route("**/api/projects", (route) => route.fulfill({ json: lists }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [{ id: "66666666-6666-4666-8666-666666666666", projectName: "Orchard CRM", inviterName: "Priya Nair", role: "EDITOR", expiresAt }], truncated: false } }));
    await page.goto("/app");
    const nav = sidebar(page);
    await expect(nav.getByText("Creating projects isn’t enabled for this account.")).toBeVisible();
    await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "No project open" })).toBeVisible();
    await expect(page.getByText("Choose a project.", { exact: true })).toBeVisible(); // no creation invite without entitlement
    await page.getByRole("button", { name: "View invitations" }).click();
    await expect(nav.getByRole("tab", { name: "Invites, 1 pending" })).toHaveAttribute("aria-selected", "true");
    await expect(nav.getByText(/From Priya Nair · Editor · Expires/)).toBeVisible();

    lists = { ...defaultLists, capacity: capacity(10, 10) };
    await page.reload();
    await expect(nav.getByRole("button", { name: "New project" })).toBeDisabled();
    await expect(nav.getByText("10 of 10 active · archive one to add another")).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "New project" })).toHaveCount(0);
    await expect(page.getByText("Choose a project or create one.")).toBeVisible();
  });

  test("docking keeps the editor at least min(W, 560) wide, closed panels reserve no width, and long names fit at 390 px", async ({ page }) => {
    await mockShell(page);
    const slot = page.locator(".sidebar-slot");
    const panel = page.locator("#right-panel");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/app/projects/${ids.alpha}`);
    await expect(page.getByRole("heading", { level: 1, name: "Alpha plan" })).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(await editorWidth(page)).toBe(1140);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(panel).toHaveAttribute("data-dock", "docked");
    await expect(slot).toHaveAttribute("data-mode", "docked");
    expect(await editorWidth(page)).toBe(780);
    await expect(page.getByRole("button", { name: "Specs", exact: true })).toHaveCount(0);
    await panel.getByRole("tab", { name: "Specs", exact: true }).click();
    await expect(panel.getByRole("tab", { name: "Specs", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator("#right-body-specs")).toBeVisible();

    // The right panel was opened last, so the sidebar that no longer fits closes instead of overlaying.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(slot).toHaveAttribute("data-mode", "closed");
    await expect(panel).toHaveAttribute("data-dock", "docked");
    expect(await editorWidth(page)).toBe(664);
    await page.getByRole("button", { name: "Show projects" }).click();
    await expect(slot).toHaveAttribute("data-mode", "overlay");
    expect(await editorWidth(page)).toBe(664);
    await page.keyboard.press("Escape");
    await expect(slot).toHaveAttribute("data-mode", "closed");
    await expect(page.getByRole("button", { name: "Show projects" })).toBeFocused();

    await page.setViewportSize({ width: 768, height: 800 });
    await expect(panel).toBeHidden();
    expect(await editorWidth(page)).toBe(768);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(panel).toHaveAttribute("data-dock", "overlay");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel.getByRole("tab", { name: "Details" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "Inspect" })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show projects" }).click();
    await expect(slot).toHaveAttribute("data-mode", "overlay");
    expect(await sidebar(page).evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(390);
    expect(await pageFits(page)).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Alpha plan" })).toBeVisible();
    await expect(slot).toHaveAttribute("data-mode", "closed");

    await test.step("a fresh long project stays within the 390 px viewport", async () => {
      await page.goto(`/app/projects/${ids.long}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute("title", longName);
      expect(await pageFits(page)).toBe(true);
      await expect(page.getByRole("button", { name: "Specs", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Show projects" }).click();
      await expect(sidebar(page).getByRole("button", { name: longName, exact: true })).toBeVisible();
      expect(await pageFits(page)).toBe(true);
      expect((await sidebar(page).getByLabel("Filter owned projects").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  });

  test("a late response for the previous project never renders in the next one", async ({ page }) => {
    await mockShell(page);
    await page.route(`**/api/projects/${ids.alpha}/bootstrap`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.fulfill({ json: bootstrap(ids.alpha, "Alpha plan") }).catch(() => undefined); // the page may have aborted it
    });
    await page.goto("/app");
    const nav = sidebar(page);
    await nav.getByRole("button", { name: "Alpha plan", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${ids.alpha}$`));
    await expect(page.getByText("Loading project…")).toBeVisible();
    await nav.getByRole("button", { name: "Beta notes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Beta notes" })).toBeVisible();
    await page.waitForTimeout(2_500);
    await expect(page.getByRole("heading", { level: 1, name: "Beta notes" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Alpha plan" })).toHaveCount(0);
  });

  test("the right panel's open state belongs to each project and survives sidebar tab changes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockShell(page);
    await page.goto(`/app/projects/${ids.alpha}`);
    const panel = page.locator("#right-panel");
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(panel.getByText("Empty draft · revision 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect" })).toHaveAttribute("aria-pressed", "true");
    const nav = sidebar(page);
    await nav.getByRole("tab", { name: "Shared with me" }).click();
    await expect(panel).toBeVisible();
    await nav.getByRole("button", { name: /^Coral review/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Coral review" })).toBeVisible();
    await expect(page.locator("#editor-main").getByText("Editor", { exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Alpha plan" })).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect" })).toHaveAttribute("aria-pressed", "true");
  });

  test("an unavailable project shows a neutral state and no project controls", async ({ page }) => {
    await mockShell(page);
    const missing = "77777777-7777-4777-8777-777777777777";
    await page.route(`**/api/projects/${missing}/bootstrap`, (route) => route.fulfill({ status: 404, json: envelope("NOT_FOUND", "This project or invitation is unavailable.") }));
    await page.goto(`/app/projects/${missing}`);
    await expect(page.getByRole("heading", { level: 1, name: "Project unavailable" })).toBeVisible();
    await expect(page.getByText("It may have been removed, or your access changed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect" })).toHaveCount(0);
  });

  test("a failed list load offers Retry and recovers", async ({ page }) => {
    let fail = true;
    await page.route("**/api/projects", (route) => fail ? route.fulfill({ status: 503, json: envelope("UNAVAILABLE", "Project access is unavailable. Try again.") }) : route.fulfill({ json: defaultLists }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: noInvites }));
    await page.goto("/app");
    const nav = sidebar(page);
    await expect(nav.getByText("Projects couldn’t load.")).toBeVisible();
    fail = false;
    await nav.getByRole("button", { name: "Retry" }).click();
    await expect(nav.getByRole("button", { name: "Alpha plan", exact: true })).toBeVisible();
  });

  test("a session that ends while the shell is open returns to sign-in", async ({ page }) => {
    await page.route("**/api/projects", (route) => route.fulfill({ status: 503, json: envelope("UNAVAILABLE", "Project access is unavailable. Try again.") }));
    await page.goto("/app");
    const nav = sidebar(page);
    await expect(nav.getByText("Projects couldn’t load.")).toBeVisible();
    await page.unroute("**/api/projects");
    await page.context().clearCookies();
    await nav.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByText("Projects couldn’t load.")).toHaveCount(0);
  });

  test("a delayed manual reload of a closed project never clobbers the next open one", async ({ page }) => {
    await mockShell(page);
    let failFirst = true;
    await page.route(`**/api/projects/${ids.alpha}/bootstrap`, async (route) => {
      if (failFirst) { failFirst = false; await route.fulfill({ status: 503, json: envelope("UNAVAILABLE", "Project access is unavailable. Try again.") }); return; }
      // Retry's re-read resolves only after the user has already switched to Beta below.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fulfill({ json: bootstrap(ids.alpha, "Alpha plan") }).catch(() => undefined); // the page may have aborted it
    });
    await page.goto(`/app/projects/${ids.alpha}`);
    await expect(page.getByRole("heading", { level: 1, name: "Project couldn’t load" })).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    const nav = sidebar(page);
    await nav.getByRole("button", { name: "Beta notes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Beta notes" })).toBeVisible();
    await page.waitForTimeout(2_000);
    await expect(page.getByRole("heading", { level: 1, name: "Beta notes" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Alpha plan" })).toHaveCount(0);
    await expect(page.getByText("Loading project…")).toHaveCount(0);
  });
});
