import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test("invitation APIs require an authenticated identity", async ({ request }) => {
  const id = randomUUID();
  expect((await request.get(`/api/projects/${id}/invitations`)).status()).toBe(401);
  expect((await request.post(`/api/projects/${id}/invitations/${id}/revoke`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedVersion: 1 } })).status()).toBe(401);
  expect((await request.post("/api/invitations/accept", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { token: "x".repeat(43) } })).status()).toBe(401);
});

test("an invited account accepts only its own project through the API", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = adminClient();
  const database = await openDatabase();
  const users: string[] = [];
  let memberContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const owner = await signIn(page, admin, users, "Invitation API Test");
    await entitle(database, owner.authUserId);
    const projectId = await createProjectViaApi(page, "Invitation API project");

    memberContext = await browser.newContext({ baseURL: appUrl });
    const memberPage = await memberContext.newPage();
    const member = await signIn(memberPage, admin, users, "Invitation API Test");
    const issued = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { verifiedEmail: member.email, role: "VIEWER" } });
    expect(issued.status()).toBe(201);
    const invitation = await issued.json() as { url: string; id: string; role: string; linkUnavailable: boolean };
    expect(invitation.linkUnavailable).toBe(false);
    const token = invitation.url.split("/").at(-1);
    expect(token).toBeTruthy();
    const accepted = await memberPage.request.post("/api/invitations/accept", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { token } });
    expect(accepted.status()).toBe(201);
    expect(await accepted.json()).toEqual({ projectId, role: "VIEWER", replayed: false });
    const memberBootstrap = await memberPage.request.get(`/api/projects/${projectId}/bootstrap`);
    expect(memberBootstrap.status()).toBe(200);
    expect(await memberBootstrap.json()).toMatchObject({ project: { id: projectId, role: "VIEWER" } });
    const listed = await page.request.get(`/api/projects/${projectId}/invitations`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toEqual({ invitations: [] });
  } finally {
    await memberContext?.close();
    await cleanupUsers(database, admin, users);
    await database.end();
  }
});
