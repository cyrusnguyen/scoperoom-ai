import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3101";

test.skip(!authUrl || !secretKey || !databaseUrl, "Requires isolated local Supabase Auth and database URLs");

test("project APIs require an authenticated identity", async ({ request }) => {
  const id = randomUUID();
  for (const path of [`/api/workspaces/${id}/projects`, `/api/projects/${id}/bootstrap`, `/api/projects/${id}/status`, `/api/projects/${id}/members`]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  const response = await request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { workspaceId: id, name: "Denied" } });
  expect(response.status()).toBe(401);
});

test("a project can be created once and remains private to its owner", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: databaseUrl! });
  const users: string[] = [];
  let otherContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  await database.connect();
  async function signIn(target: typeof page) {
    const email = `project-api-${randomUUID()}@example.test`;
    const password = `Project-${randomUUID()}-Pass!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Project API Test" } });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    users.push(data.user.id);
    await target.goto("/login");
    await target.getByLabel("Email address").fill(email);
    await target.getByLabel("Password").fill(password);
    await target.getByRole("button", { name: "Sign in" }).click();
    await expect(target).toHaveURL(/\/$/, { timeout: 15_000 });
    expect((await target.request.get("/api/workspaces")).status()).toBe(200);
    return data.user.id;
  }
  try {
    const ownerId = await signIn(page);
    const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [ownerId]);
    if (!profile) throw new Error("Owner profile missing.");
    await database.query("insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())", [profile.id]);
    const workspaceResponse = await page.request.post("/api/workspaces", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name: "Project API workspace" } });
    expect(workspaceResponse.status()).toBe(201);
    const { id: workspaceId } = await workspaceResponse.json() as { id: string };

    const key = randomUUID();
    const input = { workspaceId, name: "Private project" };
    const createdResponse = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": key }, data: input });
    expect(createdResponse.status()).toBe(201);
    expect(createdResponse.headers()["cache-control"]).toContain("no-store");
    const created = await createdResponse.json() as { id: string; replayed: boolean };
    expect(created.replayed).toBe(false);
    const replay = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": key }, data: input });
    expect(replay.status()).toBe(200);
    expect((await replay.json() as { id: string; replayed: boolean })).toMatchObject({ id: created.id, replayed: true });
    const conflict = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": key }, data: { ...input, name: "Changed" } });
    expect(conflict.status()).toBe(409);
    const listing = await page.request.get(`/api/workspaces/${workspaceId}/projects`);
    expect(listing.status()).toBe(200);
    expect((await listing.json() as { projects: Array<{ id: string }> }).projects.map((item) => item.id)).toEqual([created.id]);
    const bootstrap = await page.request.get(`/api/projects/${created.id}/bootstrap`);
    expect(bootstrap.status()).toBe(200);
    const body = await bootstrap.json() as { project: { name: string }; draft: { documentRevision: number; layoutRevision: number } };
    expect(body.project.name).toBe(input.name);
    expect(body.draft).toMatchObject({ documentRevision: 1, layoutRevision: 1 });

    const statusResponse = await page.request.get(`/api/projects/${created.id}/status`);
    expect(statusResponse.status()).toBe(200);
    const currentStatus = await statusResponse.json() as { version: number; settingsVersion: number };
    const settingsResponse = await page.request.patch(`/api/projects/${created.id}/settings`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name: "Renamed private project", expectedSettingsVersion: currentStatus.settingsVersion } });
    expect(settingsResponse.status()).toBe(200);
    expect((await settingsResponse.json() as { name: string }).name).toBe("Renamed private project");
    const archiveResponse = await page.request.post(`/api/projects/${created.id}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: currentStatus.version, reason: "Local route check" } });
    expect(archiveResponse.status()).toBe(200);
    const archivedProject = await archiveResponse.json() as { status: string; version: number };
    expect(archivedProject.status).toBe("ARCHIVED");
    const archivedWorkspaceResponse = await page.request.post(`/api/workspaces/${workspaceId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedVersion: 1 } });
    expect(archivedWorkspaceResponse.status()).toBe(200);
    const archivedWorkspace = await archivedWorkspaceResponse.json() as { status: string; version: number };
    expect(archivedWorkspace.status).toBe("ARCHIVED");
    expect((await page.request.get(`/api/projects/${created.id}/bootstrap`)).status()).toBe(200);
    const restoredWorkspace = await page.request.post(`/api/workspaces/${workspaceId}/restore`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedVersion: archivedWorkspace.version } });
    expect(restoredWorkspace.status()).toBe(200);
    const restoredProject = await page.request.post(`/api/projects/${created.id}/restore`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: archivedProject.version } });
    expect(restoredProject.status()).toBe(200);
    expect((await restoredProject.json() as { status: string }).status).toBe("ACTIVE");
    otherContext = await browser.newContext({ baseURL: appUrl });
    const otherPage = await otherContext.newPage();
    await signIn(otherPage);
    const denied = await otherPage.request.get(`/api/projects/${created.id}/bootstrap`);
    expect(denied.status()).toBe(404);
    expect(await denied.text()).not.toContain(input.name);
  } finally {
    await otherContext?.close();
    if (users.length) {
      await database.query("delete from app.mutation_receipt where actor_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.workspace where owner_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.pilot_entitlement where profile_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.user_profile where auth_user_id = any($1::uuid[])", [users]);
      await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
    }
    await database.end();
  }
});
