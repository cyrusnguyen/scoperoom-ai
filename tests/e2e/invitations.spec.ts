import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Route } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

type Account = { authId: string; email: string; password: string };
type Fixture = { owner: { authUserId: string; email: string }; invitee: Account; outsider: Account; projectId: string };

async function createAccount(admin: SupabaseClient, users: string[], label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `Invitation-${randomUUID()}-Pass!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label} invitation test` } });
  if (error || !data.user) throw error ?? new Error("Could not create test user.");
  users.push(data.user.id);
  return { authId: data.user.id, email, password };
}

async function logIn(page: Page, account: Account) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}


async function expireAccessSession(page: Page) {
  const cookie = (await page.context().cookies(appUrl)).find(({ name, value }) => name.startsWith("sb-") && name.endsWith("-auth-token") && value.startsWith("base64-"));
  if (!cookie) throw new Error("Expected a local Supabase SSR auth cookie.");
  const session = JSON.parse(Buffer.from(cookie.value.slice("base64-".length), "base64url").toString("utf8")) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
  if (!session.access_token || !session.refresh_token) throw new Error("Expected an access token and refresh token in the local Supabase session.");
  const expiredAccessToken = session.access_token;
  session.expires_at = Math.floor(Date.now() / 1000) - 120;
  session.expires_in = 0;
  await page.context().addCookies([{ ...cookie, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }]);
  return { cookieName: cookie.name, expiredAccessToken };
}

function sessionFromCookie(value: string) {
  if (!value.startsWith("base64-")) throw new Error("Expected a local Supabase SSR auth cookie.");
  return JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")) as { access_token?: string; expires_at?: number };
}
async function createFixture(page: Page, database: Client, admin: SupabaseClient, users: string[]): Promise<Fixture> {
  const invitee = await createAccount(admin, users, "invitee");
  const outsider = await createAccount(admin, users, "outsider");
  const owner = await signIn(page, admin, users, "owner invitation test");
  await entitle(database, owner.authUserId);
  const projectId = await createProjectViaApi(page, "Private invitation project");
  return { owner, invitee, outsider, projectId };
}

test.describe("project invitations", () => {
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

  test("owner shares once, survives clipboard rejection, and an invited account opens the project after reload", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => ({ writeText: () => Promise.reject(new Error("clipboard unavailable")) }) });
    });
    const fixture = await createFixture(page, database, admin, users);
    await page.goto(`/app/projects/${fixture.projectId}`);
    await expect(page.getByRole("heading", { name: "Private invitation project" })).toBeVisible();
    await page.getByRole("button", { name: "Share project" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Verified email")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByLabel("Verified email").fill(fixture.invitee.email);
    await page.getByLabel("Project role").selectOption("VIEWER");
    // Hold the list refresh that follows issuance so Copy runs while it is pending.
    const listPattern = `**/api/projects/${fixture.projectId}/invitations`;
    let releaseRefresh = () => {};
    const refreshHeld = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let issuedInvitation = false;
    await page.route(listPattern, async (route) => {
      if (route.request().method() === "POST") issuedInvitation = true;
      else if (issuedInvitation) await refreshHeld;
      await route.continue();
    });
    await page.getByRole("button", { name: "Create invitation" }).click();
    const invitationLink = page.getByLabel("One-time invitation link");
    await expect(invitationLink).toBeVisible();
    const url = await invitationLink.inputValue();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByText("Copy did not complete. Select the link and copy it manually.")).toBeVisible();
    releaseRefresh();
    await expect(page.getByText(fixture.invitee.email, { exact: true })).toBeVisible();
    await expect(page.getByText("Copy did not complete. Select the link and copy it manually.")).toBeVisible();
    await page.unroute(listPattern);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("One-time invitation link")).toHaveCount(0);
    await page.getByRole("button", { name: "Share project" }).click();
    await expect(page.getByText(fixture.invitee.email, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto(url);
    await expect(page).toHaveURL(/\/login\?continue=/);
    await page.getByLabel("Email address").fill(fixture.invitee.email);
    await page.getByLabel("Password").fill(fixture.invitee.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${fixture.projectId}$`), { timeout: 15_000 });
    const context = page.getByRole("complementary", { name: "Project details" });
    await expect(context.getByText("Viewer", { exact: true })).toBeVisible();
    await expect(context.getByRole("button", { name: "Share project" })).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/app/projects/${fixture.projectId}$`));
    await expect(page.getByRole("complementary", { name: "Project details" }).getByText("Viewer", { exact: true })).toBeVisible();
  });



  test("Share state does not carry an invitation link or recipient into another project", async ({ page }) => {
    const fixture = await createFixture(page, database, admin, users);
    const otherProjectId = await createProjectViaApi(page, "Second owner project");
    await page.goto(`/app/projects/${fixture.projectId}`);
    await page.getByRole("button", { name: "Share project" }).click();
    await page.getByLabel("Verified email").fill(fixture.invitee.email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(page.getByLabel("One-time invitation link")).toBeVisible();

    await page.getByRole("button", { name: /Second owner project/ }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${otherProjectId}$`));
    await expect(page.getByRole("heading", { name: "Second owner project" })).toBeVisible();
    await page.getByRole("button", { name: "Share project" }).click();
    await expect(page.getByLabel("One-time invitation link")).toHaveCount(0);
    await expect(page.getByLabel("Verified email")).toHaveValue("");
    await expect(page.getByText(fixture.invitee.email, { exact: true })).toHaveCount(0);
  });

  test("invite confirmations remain visible when the invitation index refresh fails", async ({ page }) => {
    const fixture = await createFixture(page, database, admin, users);
    const listPattern = `**/api/projects/${fixture.projectId}/invitations`;
    let failNextRefresh = false;
    const listHandler = async (route: Route) => {
      if (route.request().method() === "GET" && failNextRefresh) {
        failNextRefresh = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Invitation index is unavailable." } }) });
        return;
      }
      if (route.request().method() === "POST") failNextRefresh = true;
      await route.continue();
    };

    await page.goto(`/app/projects/${fixture.projectId}`);
    await page.getByRole("button", { name: "Share project" }).click();
    await page.route(listPattern, listHandler);
    await page.getByLabel("Verified email").fill(fixture.invitee.email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(page.getByText("Invitation created. Invitation index is unavailable.")).toBeVisible();
    await expect(page.getByText("Invitation details could not be refreshed. Use Refresh to retry.")).toBeVisible();

    await page.unroute(listPattern, listHandler);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(fixture.invitee.email, { exact: true })).toBeVisible();

    const revokePattern = `**/api/projects/${fixture.projectId}/invitations/*/revoke`;
    const revokeHandler = async (route: Route) => { failNextRefresh = true; await route.continue(); };
    await page.route(listPattern, listHandler);
    await page.route(revokePattern, revokeHandler);
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Invitation revoked. You can create a replacement invitation. Invitation index is unavailable.")).toBeVisible();
    await expect(page.getByText("Invitation details could not be refreshed. Use Refresh to retry.")).toBeVisible();
  });
  test("an expired access session refreshes on an invitation route before acceptance", async ({ page }) => {
    const fixture = await createFixture(page, database, admin, users);
    await page.goto(`/app/projects/${fixture.projectId}`);
    await page.getByRole("button", { name: "Share project" }).click();
    await page.getByLabel("Verified email").fill(fixture.invitee.email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    const url = await page.getByLabel("One-time invitation link").inputValue();
    await page.getByRole("button", { name: "Sign out" }).click();
    await logIn(page, fixture.invitee);
    const expired = await expireAccessSession(page);

    await page.goto(url);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${fixture.projectId}$`), { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Project details" }).getByText("Editor", { exact: true })).toBeVisible();
    const refreshedCookie = (await page.context().cookies(appUrl)).find(({ name }) => name === expired.cookieName);
    expect(refreshedCookie).toBeTruthy();
    const refreshed = sessionFromCookie(refreshedCookie!.value);
    expect(refreshed.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(refreshed.access_token).not.toBe(expired.expiredAccessToken);
  });
  test("wrong account receives a neutral invitation denial without project metadata", async ({ page }) => {
    const fixture = await createFixture(page, database, admin, users);
    await page.goto(`/app/projects/${fixture.projectId}`);
    await page.getByRole("button", { name: "Share project" }).click();
    await page.getByLabel("Verified email").fill(fixture.invitee.email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    const url = await page.getByLabel("One-time invitation link").inputValue();
    await page.getByRole("button", { name: "Sign out" }).click();
    await logIn(page, fixture.outsider);
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Open a shared project" })).toBeVisible();
    await expect(page.getByText("Private invitation project", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use another account" })).toBeVisible();
    await page.getByRole("button", { name: "Use another account" }).click();
    await expect(page).toHaveURL(/\/login\?continue=/);
    await page.getByLabel("Email address").fill(fixture.invitee.email);
    await page.getByLabel("Password").fill(fixture.invitee.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${fixture.projectId}$`), { timeout: 15_000 });
  });
});