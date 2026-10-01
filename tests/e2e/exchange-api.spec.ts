import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const nativeFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
const streamedUpload = (url: string, cookie: string, key: string, bytes: Buffer) => new Promise<{ status: number; body: unknown; cache: string | undefined }>((resolve, reject) => {
  const target = new URL(url, appUrl);
  const upload = request(target, { method: "POST", headers: { Origin: appUrl, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": key, "Transfer-Encoding": "chunked" } }, (response) => {
    const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()), cache: response.headers["cache-control"] }));
  });
  expect(upload.getHeader("content-length")).toBeUndefined();
  upload.on("error", reject);
  upload.write(bytes.subarray(0, Math.min(bytes.length, 524288)));
  upload.end(bytes.subarray(Math.min(bytes.length, 524288)));
});

test("flow import preview requires the authenticated original actor and recovers the same keyed upload", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const unknownProject = randomUUID();
  const unknownPreview = randomUUID();
  expect((await request.get(`/api/projects/${unknownProject}/flow-imports/${unknownPreview}`)).status()).toBe(401);
  expect((await request.post(`/api/projects/${unknownProject}/flow-imports/preview?draftId=${randomUUID()}&previewId=${unknownPreview}`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID(), "Content-Type": "application/json" }, data: await nativeFile() })).status()).toBe(401);
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
    const oversize = await streamedUpload(url, cookie, randomUUID(), Buffer.alloc(1_048_577));
    expect(oversize).toMatchObject({ status: 413, body: { error: { code: "LIMIT_EXCEEDED", retryable: false } } });
    expect(oversize.cache).toContain("no-store");
    const headers = { Origin: appUrl, "Idempotency-Key": randomUUID(), "Content-Type": "application/json" };
    expect((await page.request.post(url, { headers: { ...headers, Origin: "" }, data: await nativeFile() })).status()).toBe(403);
    expect((await page.request.post(url, { headers, data: Buffer.alloc(1_048_577) })).status()).toBe(413);
    const malformed = await page.request.post(url, { headers, data: Buffer.from([0xc3, 0x28]) });
    expect(malformed.status()).toBe(400); expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    const foreign = await page.request.post(url, { headers, data: Buffer.from(JSON.stringify({ format: "foreign", formatVersion: 1 })) });
    expect(foreign.status()).toBe(422); expect(await foreign.json()).toMatchObject({ error: { code: "UNSUPPORTED_FLOW_FORMAT" } });
    expect((await page.request.post(url, { headers: { ...headers, "Content-Type": "application/jsonfoo" }, data: await nativeFile() })).status()).toBe(400);
    const streamed = await streamedUpload(url, cookie, key, await nativeFile());
    expect(streamed.status).toBe(200); expect(streamed.cache).toContain("no-store");
    const upload = async () => page.request.post(url, { headers: { Origin: appUrl, "Idempotency-Key": key, "Content-Type": "application/json" }, data: await nativeFile() });
    const first = await upload();
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toContain("no-store");
    const preview = await first.json() as { id: string; state: string; file: { format: string }; positions: unknown[] };
    expect(preview).toMatchObject({ id: previewId, state: "READY", file: { format: "scoperoom-flow" } });
    expect(preview.positions.length).toBeGreaterThan(0);
    expect(await (await upload()).json()).toEqual(preview);
    expect(streamed.body).toEqual(preview);
    const read = await page.request.get(`/api/projects/${projectId}/flow-imports/${previewId}`);
    expect(read.headers()["cache-control"]).toContain("no-store"); expect(await read.json()).toEqual(preview);
    expect(await (await page.request.get(`/api/projects/${projectId}/drafts/${draftId}`)).json()).toMatchObject({ id: draftId, documentRevision: 1, layoutRevision: 1 });

    const otherPage = await other.newPage();
    const editor = await signIn(otherPage, admin, users, "Preview API editor");
    const issued = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { verifiedEmail: editor.email, role: "EDITOR" } });
    expect(issued.status()).toBe(201);
    const token = (await issued.json() as { url: string }).url.split("/").at(-1);
    expect((await otherPage.request.post("/api/invitations/accept", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { token } })).status()).toBe(201);
    expect((await otherPage.request.get(`/api/projects/${projectId}/flow-imports/${previewId}`)).status()).toBe(404);
    const discardKey = randomUUID();
    const discard = () => page.request.post(`/api/projects/${projectId}/flow-imports/${previewId}/discard`, { headers: { Origin: appUrl, "Idempotency-Key": discardKey }, data: {} });
    const discarded = await discard(); expect(discarded.status()).toBe(200); expect(discarded.headers()["cache-control"]).toContain("no-store");
    expect(await discarded.json()).toMatchObject({ id: previewId, state: "DISCARDED" });
    expect(await (await discard()).json()).toEqual(await discarded.json());
    expect(await (await page.request.get(`/api/projects/${projectId}/drafts/${draftId}`)).json()).toMatchObject({ documentRevision: 1, layoutRevision: 1 });
    await otherPage.close();
  } finally {
    await other.close();
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});
