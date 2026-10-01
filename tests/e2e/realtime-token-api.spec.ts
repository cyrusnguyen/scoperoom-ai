import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.3 Task 6: the HTTP contract of the scoped Realtime credential route, through the real server. A missing signing configuration
// (503) is covered in tests/integration/realtime-token.test.ts: it would need a second server here.
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const errorOf = async (response: { json: () => Promise<unknown> }) => (await response.json() as { error: { code: string; message: string; requestId: string } }).error;

test("the token route refuses a foreign origin before identity, refuses anonymous callers, and never caches", async ({ request }) => {
  const url = `/api/projects/${randomUUID()}/realtime-token`;
  // The same-origin check runs before authentication: a missing or foreign Origin is refused outright, even with no session at all.
  for (const origin of [undefined, "https://evil.example"]) {
    const refused = await request.post(url, { headers: origin ? { Origin: origin } : {} });
    expect(refused.status()).toBe(403);
    expect(refused.headers()["cache-control"]).toContain("no-store");
    expect((await errorOf(refused)).code).toBe("INVALID_REQUEST");
  }
  const anonymous = await request.post(url, { headers: { Origin: appUrl } });
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()["cache-control"]).toContain("no-store");
  const error = await errorOf(anonymous);
  expect(error.code).toBe("UNAUTHENTICATED");
  expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a member gets exactly a scoped credential; a stranger, a missing project and a body are refused without disclosure", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  const other = await browser.newContext({ baseURL: appUrl });
  try {
    const { authUserId } = await signIn(page, admin, users, "Token owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Token project");
    const url = `/api/projects/${projectId}/realtime-token`;
    const { realtimeEpoch } = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { realtimeEpoch: string };

    const issued = await page.request.post(url, { headers: { Origin: appUrl } });
    expect(issued.status()).toBe(200);
    expect(issued.headers()["cache-control"]).toContain("no-store");
    const body = await issued.json() as { accessToken: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["accessToken", "expiresAt"]);
    const claims = claimsOf(body.accessToken);
    expect(claims).toMatchObject({ role: "app_realtime_client", project_id: projectId, realtime_epoch: realtimeEpoch, exp: body.expiresAt });
    expect(claims).not.toHaveProperty("sub"); // scope only: no Auth subject, session or email
    expect(claims.exp as number - (claims.iat as number)).toBe(300); // the documented lifetime, whatever the clocks say
    expect(body.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(0);

    // A body is refused (400), whatever it holds.
    const withBody = await page.request.post(url, { headers: { Origin: appUrl }, data: { projectId } });
    expect(withBody.status()).toBe(400);
    expect(withBody.headers()["cache-control"]).toContain("no-store");
    expect((await errorOf(withBody)).code).toBe("INVALID_INPUT");

    // A stranger, a malformed id and an unknown project all get the same non-disclosing 404.
    const stranger = await other.newPage();
    await signIn(stranger, admin, users, "Token stranger");
    const denials = [
      await stranger.request.post(url, { headers: { Origin: appUrl } }),
      await stranger.request.post(`/api/projects/not-a-uuid/realtime-token`, { headers: { Origin: appUrl } }),
      await page.request.post(`/api/projects/${randomUUID()}/realtime-token`, { headers: { Origin: appUrl } }),
    ];
    for (const denial of denials) {
      expect(denial.status()).toBe(404);
      expect(denial.headers()["cache-control"]).toContain("no-store");
      const text = await denial.text();
      expect(text).not.toContain(realtimeEpoch);
      expect(text).not.toContain("accessToken");
      expect(JSON.parse(text).error.code).toBe("NOT_FOUND");
    }
    const [first, ...rest] = await Promise.all(denials.map(async (denial) => { const { code, message } = await errorOf(denial); return { code, message }; }));
    for (const other of rest) expect(other).toEqual(first); // a stranger, a malformed id and an unknown project are indistinguishable
  } finally { await other.close(); await cleanupUsers(database, admin, users, page); await database.end(); }
});
