import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const nativeFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
const streamedUpload = (url: string, cookie: string, key: string) => new Promise<number>((resolve, reject) => {
  const target = new URL(url, appUrl);
  const upload = request(target, { method: "POST", headers: { Origin: appUrl, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": key } }, (response) => {
    response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
  });
  upload.on("error", reject);
  upload.end(Buffer.alloc(1_048_577));
});

test("flow import preview requires the authenticated original actor and recovers the same keyed upload", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const unknownProject = randomUUID();
  const unknownPreview = randomUUID();
  expect((await request.get(`/api/projects/${unknownProject}/flow-imports/${unknownPreview}`)).status()).toBe(401);
  expect((await request.post(`/api/projects/${unknownProject}/flow-imports/preview?draftId=${randomUUID()}&previewId=${unknownPreview}`, { headers: { Origin: "https://evil.example", "Idempotency-Key": randomUUID(), "Content-Type": "application/json" }, data: await nativeFile() })).status()).toBe(403);

  const admin = adminClient(); const database = await openDatabase(); const users: string[] = []; const other = await browser.newContext();
  try {
    const { authUserId } = await signIn(page, admin, users, "Preview API owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Preview API project");
    const draftId = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number; layoutRevision: number } }).draft.id;
    const previewId = randomUUID(); const key = randomUUID();
    const url = `/api/projects/${projectId}/flow-imports/preview?draftId=${draftId}&previewId=${previewId}`;
    const cookie = (await page.context().cookies(appUrl)).map(({ name, value }) => `${name}=${value}`).join("; ");
    const streamedStatus = await streamedUpload(url, cookie, randomUUID());
    expect(streamedStatus).toBe(413);
    const upload = async () => page.request.post(url, { headers: { Origin: appUrl, "Idempotency-Key": key, "Content-Type": "application/json" }, data: await nativeFile() });
    const first = await upload();
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toContain("no-store");
    const preview = await first.json() as { id: string; state: string; file: { format: string }; positions: unknown[] };
    expect(preview).toMatchObject({ id: previewId, state: "READY", file: { format: "scoperoom-flow" } });
    expect(preview.positions.length).toBeGreaterThan(0);
    expect(await (await upload()).json()).toEqual(preview);
    expect(await (await page.request.get(`/api/projects/${projectId}/drafts/${draftId}`)).json()).toMatchObject({ id: draftId, documentRevision: 1, layoutRevision: 1 });

    const otherPage = await other.newPage();
    await signIn(otherPage, admin, users, "Preview API outsider");
    expect((await otherPage.request.get(`/api/projects/${projectId}/flow-imports/${previewId}`)).status()).toBe(404);
    await otherPage.close();
  } finally {
    await other.close();
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});
