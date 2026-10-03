import { createHmac, randomUUID } from "node:crypto";
import { request as nodeRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 06.1 Task 3: the HTTP contract of the AI run and source-version routes through the real server (202 only after commit, no-store,
// Origin, body limit, 401/403/404 and cancel authority). Admission needs AI_MODEL and AI_EXECUTION_BINDING in the server's environment.
const configured = Boolean(process.env.AI_MODEL && process.env.AI_EXECUTION_BINDING);
const errorOf = async (response: { json: () => Promise<unknown> }) => (await response.json() as { error: { code: string; retryable: boolean; details?: Record<string, unknown> } }).error;
const mutation = (key = randomUUID(), origin = appUrl) => ({ Origin: origin, "Idempotency-Key": key });
// Same keyed subject as admissionSubject (HMAC over the environment id); copied so the spec never loads the server module graph.
const subjectOf = (profileId: string) => createHmac("sha256", process.env.SCOPEROOM_ENVIRONMENT_ID!).update(`AI_ADMISSION:${profileId}`).digest("hex");
const chunkedPost = (url: string, cookie: string, bytes: Buffer) => new Promise<{ status: number; body: { error: { code: string; details?: Record<string, unknown> } }; cache: string | undefined }>((resolve, reject) => {
  const upload = nodeRequest(new URL(url, appUrl), { method: "POST", headers: { Origin: appUrl, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "Transfer-Encoding": "chunked" } }, (response) => {
    const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()), cache: response.headers["cache-control"] }));
  });
  upload.on("error", reject);
  upload.write(bytes.subarray(0, 40_000));
  upload.end(bytes.subarray(40_000));
});

test("the AI routes refuse anonymous callers and a foreign origin, and never cache", async ({ request }) => {
  const project = `/api/projects/${randomUUID()}`;
  for (const [method, path] of [["get", `${project}/ai-runs`], ["post", `${project}/ai-runs`], ["get", `${project}/ai-runs/${randomUUID()}`], ["post", `${project}/ai-runs/${randomUUID()}/cancel`], ["get", `${project}/source-versions/${randomUUID()}`]] as const) {
    const anonymous = await request[method](path, method === "post" ? { headers: mutation(), data: {} } : {});
    expect(anonymous.status(), path).toBe(401);
    expect(anonymous.headers()["cache-control"]).toContain("no-store");
    expect((await errorOf(anonymous)).code).toBe("UNAUTHENTICATED");
  }
  for (const path of [`${project}/ai-runs`, `${project}/ai-runs/${randomUUID()}/cancel`]) {
    for (const origin of ["https://evil.example", ""]) {
      const refused = await request.post(path, { headers: mutation(randomUUID(), origin), data: {} });
      expect(refused.status(), `${path} ${origin}`).toBe(403);
      expect(refused.headers()["cache-control"]).toContain("no-store");
    }
  }
});

test("an unconfigured server refuses admission as unavailable and creates nothing", async ({ page }) => {
  test.skip(configured, "Covers the unconfigured server only");
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  try {
    const { authUserId } = await signIn(page, admin, users, "AI unconfigured owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "AI unconfigured");
    const draft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft;
    const response = await page.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: { taskType: "PROPOSE_FLOW", prompt: "Outline checkout", draftId: draft.id, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } } });
    expect(response.status()).toBe(503); expect((await errorOf(response)).code).toBe("UNAVAILABLE");
    expect((await database.query("select count(*)::int n from app.ai_run where project_id = $1", [projectId])).rows[0].n).toBe(0);
  } finally {
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});

test("start is 202 only after commit, replays by key, enforces limits and authority, and cancel keeps the slot", async ({ page, browser }) => {
  test.skip(!configured, "Requires AI_MODEL and AI_EXECUTION_BINDING for the server under test");
  test.setTimeout(120_000);
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = []; const editorContext = await browser.newContext(); const strangerContext = await browser.newContext();
  let ownerProfile: string | null = null;
  try {
    const { authUserId } = await signIn(page, admin, users, "AI API owner");
    await entitle(database, authUserId);
    ownerProfile = (await database.query("select id from app.user_profile where auth_user_id = $1", [authUserId])).rows[0].id as string;
    const projectId = await createProjectViaApi(page, "AI API project");
    const draft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft;
    const base = `/api/projects/${projectId}/ai-runs`;
    const body = { taskType: "PROPOSE_FLOW", prompt: "Outline the checkout flow", draftId: draft.id, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } };

    // Transport: content type, key, strict body and the 64 KiB bound (declared and streamed) are refused before any parsing or admission.
    expect((await page.request.post(base, { headers: { ...mutation(), "Content-Type": "text/plain" }, data: JSON.stringify(body) })).status()).toBe(400);
    expect((await page.request.post(base, { headers: { Origin: appUrl }, data: body })).status()).toBe(400);
    const extra = await page.request.post(base, { headers: mutation(), data: { ...body, actorId: randomUUID() } });
    expect(extra.status()).toBe(400); expect((await errorOf(extra)).code).toBe("INVALID_INPUT");
    const oversize = await page.request.post(base, { headers: mutation(), data: { ...body, prompt: "x".repeat(70_000) } });
    expect(oversize.status()).toBe(413); expect(oversize.headers()["cache-control"]).toContain("no-store");
    expect(await errorOf(oversize)).toMatchObject({ code: "LIMIT_EXCEEDED", retryable: false, details: { limit: "START_BODY_BYTES" } });
    const cookie = (await page.context().cookies(appUrl)).map(({ name, value }) => `${name}=${value}`).join("; ");
    const streamed = await chunkedPost(base, cookie, Buffer.from(JSON.stringify({ ...body, prompt: "x".repeat(70_000) })));
    expect(streamed.status).toBe(413); expect(streamed.body.error).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "START_BODY_BYTES" } }); expect(streamed.cache).toContain("no-store");
    const unknownDraft = await page.request.post(base, { headers: mutation(), data: { ...body, draftId: randomUUID() } });
    expect(unknownDraft.status()).toBeGreaterThanOrEqual(409);
    expect((await database.query("select count(*)::int n from app.ai_run where project_id = $1", [projectId])).rows[0].n).toBe(0);

    // Start: 202 carries a durable identity that already exists when the response is read.
    const key = randomUUID();
    const started = await page.request.post(base, { headers: mutation(key), data: body });
    expect(started.status()).toBe(202); expect(started.headers()["cache-control"]).toContain("no-store");
    const run = await started.json() as { runId: string; state: string; aiRevision: number; replayed: boolean };
    expect(run).toMatchObject({ state: "QUEUED", replayed: false });
    expect((await database.query("select state::text, actor_id from app.ai_run where id = $1", [run.runId])).rows[0]).toMatchObject({ state: "QUEUED", actor_id: ownerProfile });
    const replay = await page.request.post(base, { headers: mutation(key), data: body });
    expect(replay.status()).toBe(200); expect(await replay.json()).toEqual({ ...run, replayed: true });
    expect((await page.request.post(base, { headers: mutation(key), data: { ...body, prompt: "Different" } })).status()).toBe(409);
    const busy = await page.request.post(base, { headers: mutation(), data: body });
    expect(busy.status()).toBe(409); expect(await errorOf(busy)).toMatchObject({ code: "AI_BUSY", details: { scope: "PROJECT" } });

    // Reads: status carries the family cursor; history has no prompt body; the run view carries the exact capture and no secret.
    const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { aiRevision: number; approvedSnapshotId: string | null; eventSequence: number };
    expect(status).toMatchObject({ aiRevision: run.aiRevision, approvedSnapshotId: null, eventSequence: run.aiRevision });
    const list = await page.request.get(base); expect(list.status()).toBe(200); expect(list.headers()["cache-control"]).toContain("no-store");
    const page1 = await list.json() as { runs: Array<{ id: string }>; nextCursor: string | null };
    expect(page1.runs.map((entry) => entry.id)).toEqual([run.runId]); expect(page1.nextCursor).toBeNull();
    expect(JSON.stringify(page1)).not.toContain("Outline the checkout flow");
    expect((await page.request.get(`${base}?cursor=%21%21`)).status()).toBe(400);
    const read = await page.request.get(`${base}/${run.runId}`); expect(read.status()).toBe(200); expect(read.headers()["cache-control"]).toContain("no-store");
    const view = await read.json() as { state: string; capture: { prompt: string }; applicability: string };
    expect(view).toMatchObject({ state: "QUEUED", capture: { prompt: "Outline the checkout flow" }, applicability: "UNAVAILABLE" });
    expect(JSON.stringify(view)).not.toMatch(/dispatch|taskId|executionBinding|attemptToken/i);
    expect((await page.request.get(`${base}/${randomUUID()}`)).status()).toBe(404);

    // The prompt evidence is an exact immutable source version for any member of this project only.
    const promptVersion = (await database.query("select prompt_source_version_id id from app.ai_run where id = $1", [run.runId])).rows[0].id as string;
    const source = await page.request.get(`/api/projects/${projectId}/source-versions/${promptVersion}`);
    expect(source.status()).toBe(200); expect(source.headers()["cache-control"]).toContain("no-store");
    expect(await source.json()).toMatchObject({ id: promptVersion, text: "Outline the checkout flow", kind: "AI_PROMPT", sequence: 1, lineStarts: [0] });
    const otherProject = await createProjectViaApi(page, "AI API other project");
    expect((await page.request.get(`/api/projects/${otherProject}/source-versions/${promptVersion}`)).status()).toBe(404);
    expect((await page.request.get(`/api/projects/${otherProject}/ai-runs/${run.runId}`)).status()).toBe(404);

    // Authority: a stranger is refused without disclosure; a second editor reads but cannot cancel; the owner can.
    const strangerPage = await strangerContext.newPage(); await signIn(strangerPage, admin, users, "AI API stranger");
    expect((await strangerPage.request.get(`${base}/${run.runId}`)).status()).toBe(404);
    expect((await strangerPage.request.post(`${base}/${run.runId}/cancel`, { headers: mutation(), data: {} })).status()).toBe(404);
    const editorPage = await editorContext.newPage(); const editor = await signIn(editorPage, admin, users, "AI API editor");
    const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
    expect(invitation.status()).toBe(201);
    expect((await editorPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } })).status()).toBe(201);
    expect((await editorPage.request.get(`${base}/${run.runId}`)).status()).toBe(200);
    const denied = await editorPage.request.post(`${base}/${run.runId}/cancel`, { headers: mutation(), data: {} });
    expect(denied.status()).toBe(403); expect((await errorOf(denied)).code).toBe("FORBIDDEN");
    expect((await page.request.post(`${base}/${run.runId}/cancel`, { headers: mutation(), data: { reason: "x" } })).status()).toBe(400);
    const cancelKey = randomUUID();
    const cancelled = await page.request.post(`${base}/${run.runId}/cancel`, { headers: mutation(cancelKey), data: {} });
    expect(cancelled.status()).toBe(200); expect(cancelled.headers()["cache-control"]).toContain("no-store");
    const result = await cancelled.json() as { runId: string; cancelRequested: boolean; aiRevision: number; replayed: boolean };
    expect(result).toMatchObject({ runId: run.runId, cancelRequested: true, replayed: false }); expect(result.aiRevision).toBeGreaterThan(run.aiRevision);
    expect(await (await page.request.post(`${base}/${run.runId}/cancel`, { headers: mutation(cancelKey), data: {} })).json()).toEqual({ ...result, replayed: true });
    // Intent only: Apply is off and the run still holds its slot, nonterminal.
    const after = await (await page.request.get(`${base}/${run.runId}`)).json() as { state: string; cancelRequestedAt: string | null; applicability: string };
    expect(after).toMatchObject({ state: "QUEUED", applicability: "UNAVAILABLE" }); expect(after.cancelRequestedAt).not.toBeNull();
    expect((await page.request.post(base, { headers: mutation(), data: body })).status()).toBe(409);
    expect((await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { aiRevision: number }).aiRevision).toBe(result.aiRevision);
    await editorPage.close(); await strangerPage.close();
  } finally {
    await editorContext.close(); await strangerContext.close();
    await cleanupUsers(database, admin, users, page);
    if (ownerProfile) await database.query("delete from app.rate_limit_bucket where subject_hash = $1", [subjectOf(ownerProfile)]);
    await database.end();
  }
});
