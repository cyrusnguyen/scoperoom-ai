import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.E2E_DATABASE_URL;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3103";

test.skip(!authUrl || !secretKey || !databaseUrl, "Requires isolated local Supabase Auth and database URLs");

test("invitation APIs require an authenticated identity", async ({ request }) => {
  const id = randomUUID();
  expect((await request.get(`/api/projects/${id}/invitations`)).status()).toBe(401);
  expect((await request.post(`/api/projects/${id}/invitations/${id}/revoke`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedVersion: 1 } })).status()).toBe(401);
  expect((await request.post("/api/invitations/accept", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { token: "x".repeat(43) } })).status()).toBe(401);
});

test("an invited account accepts only its own project through the API", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: databaseUrl! });
  const users: string[] = [];
  let memberContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  await database.connect();
  async function signIn(target: typeof page) {
    const email = `invite-api-${randomUUID()}@example.test`;
    const password = `Invite-${randomUUID()}-Pass!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Invitation API Test" } });
    if (error || !data.user) throw error ?? new Error("Could not create test user.");
    users.push(data.user.id);
    await target.goto("/login");
    await target.getByLabel("Email address").fill(email);
    await target.getByLabel("Password").fill(password);
    await target.getByRole("button", { name: "Sign in" }).click();
    await expect(target).toHaveURL(/\/$/, { timeout: 15_000 });
    expect((await target.request.get("/api/workspaces")).status()).toBe(200);
    return { authUserId: data.user.id, email };
  }
  try {
    const owner = await signIn(page);
    const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [owner.authUserId]);
    if (!profile) throw new Error("Owner profile missing.");
    await database.query("insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())", [profile.id]);
    const workspace = await page.request.post("/api/workspaces", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name: "Invitation API workspace" } });
    expect(workspace.status()).toBe(201);
    const { id: workspaceId } = await workspace.json() as { id: string };
    const project = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { workspaceId, name: "Invitation API project" } });
    expect(project.status()).toBe(201);
    const { id: projectId } = await project.json() as { id: string };

    memberContext = await browser.newContext({ baseURL: appUrl });
    const memberPage = await memberContext.newPage();
    const member = await signIn(memberPage as typeof page);
    const issued = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { verifiedEmail: member.email, role: "VIEWER" } });
    expect(issued.status()).toBe(201);
    const invitation = await issued.json() as { url: string; id: string; role: string; linkUnavailable: boolean };
    expect(invitation.linkUnavailable).toBe(false);
    const token = invitation.url.split("/").at(-1);
    expect(token).toBeTruthy();
    const accepted = await memberPage.request.post("/api/invitations/accept", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { token } });
    expect(accepted.status()).toBe(201);
    expect(await accepted.json()).toMatchObject({ projectId, workspaceId, role: "VIEWER", replayed: false });
    const memberBootstrap = await memberPage.request.get(`/api/projects/${projectId}/bootstrap`);
    expect(memberBootstrap.status()).toBe(200);
    expect(await memberBootstrap.json()).toMatchObject({ project: { id: projectId, role: "VIEWER" } });
    const listed = await page.request.get(`/api/projects/${projectId}/invitations`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toEqual({ invitations: [] });
  } finally {
    await memberContext?.close();
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
