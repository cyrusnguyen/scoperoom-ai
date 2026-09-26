import { expect, test } from "@playwright/test";
import { adminClient, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

type StoredSession = { expires_at: number } & Record<string, unknown>;
const authCookie = /^sb-.+-auth-token(\.\d+)?$/;

function decode(value: string): StoredSession {
  const encoded = value.startsWith("base64-") ? value.slice("base64-".length) : value;
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StoredSession;
}

test("session cookies are HttpOnly/Lax and the security headers are present", async ({ page }) => {
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  try {
    await signIn(page, admin, users);
    const cookies = (await page.context().cookies()).filter((cookie) => authCookie.test(cookie.name));
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) { expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe("Lax"); }
    const response = await page.request.get("/");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    const api = await page.request.get("/api/me");
    expect(api.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  } finally { await cleanupUsers(database, admin, users); await database.end(); }
});

test("an expired access token on a project page is refreshed and saved", async ({ page, context }) => {
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  try {
    const { authUserId } = await signIn(page, admin, users, "Session Owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Session project");
    const cookies = (await context.cookies()).filter((cookie) => authCookie.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name));
    const session = decode(cookies.map((cookie) => cookie.value).join(""));
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    const baseName = cookies[0]!.name.replace(/\.\d+$/, "");
    await context.clearCookies({ name: authCookie });
    await context.addCookies([{ ...cookies[0]!, name: baseName, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }]);

    const response = await page.goto(`/app/projects/${projectId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Session project" }).first()).toBeVisible();
    const refreshed = decode((await context.cookies()).filter((cookie) => authCookie.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)).map((cookie) => cookie.value).join(""));
    expect(refreshed.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Session project" }).first()).toBeVisible();
  } finally { await cleanupUsers(database, admin, users); await database.end(); }
});
