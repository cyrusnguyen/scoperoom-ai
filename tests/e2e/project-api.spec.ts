import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test("project APIs require an authenticated identity and never cache", async ({ request }) => {
  const id = randomUUID();
  for (const path of ["/api/projects", "/api/invitations", `/api/projects/${id}/bootstrap`, `/api/projects/${id}/status`, `/api/projects/${id}/members`]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect((await response.json() as { error: { requestId: string } }).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  }
  expect((await request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name: "Denied" } })).status()).toBe(401);
});

test("a project is created once, owned by its creator and private to others", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  const other = await browser.newContext();
  try {
    const { authUserId } = await signIn(page, admin, users, "API Owner");
    const denied = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name: "No entitlement" } });
    expect(denied.status()).toBe(403);
    expect((await denied.json() as { error: { code: string } }).error.code).toBe("ENTITLEMENT_REQUIRED");
    await entitle(database, authUserId);
    const key = randomUUID();
    const created = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": key }, data: { name: "Private project" } });
    expect(created.status()).toBe(201);
    const project = await created.json() as { id: string; replayed: boolean };
    const replay = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": key }, data: { name: "Private project" } });
    expect(replay.status()).toBe(200);
    expect((await replay.json() as { id: string }).id).toBe(project.id);
    const lists = await (await page.request.get("/api/projects")).json() as { owned: { items: Array<{ id: string; role: string }> } };
    expect(lists.owned.items).toEqual([expect.objectContaining({ id: project.id, role: "OWNER" })]);
    const otherPage = await other.newPage();
    await signIn(otherPage, admin, users, "API Outsider");
    expect((await otherPage.request.get(`/api/projects/${project.id}/bootstrap`)).status()).toBe(404);
  } finally { await other.close(); await cleanupUsers(database, admin, users); await database.end(); }
});
