import { createHmac, randomUUID } from "node:crypto";
import { request as nodeRequest } from "node:http";
import type { Page } from "@playwright/test";
import type { Client } from "pg";
import { canonicalJson, sha256 } from "../../src/features/proposals/domain/capture";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 06.1 Task 3: the HTTP contract of the AI run and source-version routes through the real server (202 only after commit, no-store,
// Origin, body limit, 401/403/404 and cancel authority). The production runner gives the server its AI_MODEL and AI_EXECUTION_BINDING.
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
  for (const [method, path] of [["get", `${project}/ai-runs`], ["post", `${project}/ai-runs`], ["get", `${project}/ai-runs/${randomUUID()}`], ["post", `${project}/ai-runs/${randomUUID()}/cancel`], ["post", `${project}/ai-runs/${randomUUID()}/apply`], ["post", `${project}/ai-runs/${randomUUID()}/discard`], ["get", `${project}/source-versions/${randomUUID()}`]] as const) {
    const anonymous = await request[method](path, method === "post" ? { headers: mutation(), data: {} } : {});
    expect(anonymous.status(), path).toBe(401);
    expect(anonymous.headers()["cache-control"]).toContain("no-store");
    expect((await errorOf(anonymous)).code).toBe("UNAUTHENTICATED");
  }
  for (const path of [`${project}/ai-runs`, `${project}/ai-runs/${randomUUID()}/cancel`, `${project}/ai-runs/${randomUUID()}/apply`, `${project}/ai-runs/${randomUUID()}/discard`]) {
    for (const origin of ["https://evil.example", ""]) {
      const refused = await request.post(path, { headers: mutation(randomUUID(), origin), data: {} });
      expect(refused.status(), `${path} ${origin}`).toBe(403);
      expect(refused.headers()["cache-control"]).toContain("no-store");
    }
  }
});

test("start is 202 only after commit, replays by key, enforces limits and authority, and cancel keeps the slot", async ({ page, browser }) => {
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
    expect(unknownDraft.status()).toBe(409); expect((await errorOf(unknownDraft)).code).toBe("DRAFT_REPLACED");
    expect((await database.query("select count(*)::int n from app.ai_run where project_id = $1", [projectId])).rows[0].n).toBe(0);

    // Start: 202 carries a durable identity that already exists when the response is read.
    const key = randomUUID();
    const started = await page.request.post(base, { headers: mutation(key), data: body });
    expect(started.status()).toBe(202); expect(started.headers()["cache-control"]).toContain("no-store");
    const run = await started.json() as { runId: string; state: string; aiRevision: number; replayed: boolean; manifest: Record<string, unknown> };
    expect(run).toMatchObject({ state: "QUEUED", replayed: false });
    // The minimal captured manifest: identity of the exact input, no prompt or source text.
    expect(run.manifest).toEqual({ taskType: "PROPOSE_FLOW", draftId: draft.id, documentRevision: 1, parentSnapshotId: null, sourceVersionIds: [], captureHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(run)).not.toContain("Outline the checkout flow");
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

// Stored synthetic completion only: no model, worker dispatcher or provider call is composed by these HTTP tests.
const reviewedProposal = { schemaVersion: 1, kind: "proposal", operations: [
  { id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW", payload: { ref: "flow", title: "Reviewed checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } } },
  { id: "step", dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: "step", flowId: "flow", kind: "ACTION", label: "Pay", description: "", actorLabel: "" } } },
], assumptions: [], citations: [] };
async function completedRun(page: Page, database: Client, projectId: string) {
  const draft = (await database.query("select d.id, d.document_revision from app.project p join app.scope_draft d on d.id = p.current_draft_id where p.id = $1", [projectId])).rows[0];
  const response = await page.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: { taskType: "PROPOSE_FLOW", prompt: "Create checkout", draftId: draft.id, expectedDocumentRevision: draft.document_revision, expectedParentSnapshotId: null, context: { selection: null, sources: [] } } });
  expect(response.status()).toBe(202);
  const runId = (await response.json() as { runId: string }).runId;
  const hash = sha256(canonicalJson(reviewedProposal));
  await database.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [runId]);
  await database.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', terminal_at = now(), result = $2::jsonb, result_hash = $3 where id = $1", [runId, JSON.stringify(reviewedProposal), hash]);
  return { runId, body: { draftId: draft.id as string, expectedDocumentRevision: draft.document_revision as number, expectedParentSnapshotId: null, resultHash: hash, selectedOperationIds: ["flow", "step"] } };
}

test("Apply is strict, refuses stale and invalid subsets, and recovers a lost response exactly once", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const admin = adminClient(), database = await openDatabase(), users: string[] = [];
  const viewerContext = await browser.newContext(), strangerContext = await browser.newContext();
  let ownerProfile: string | null = null;
  try {
    const owner = await signIn(page, admin, users, "Apply owner"); await entitle(database, owner.authUserId);
    ownerProfile = (await database.query("select id from app.user_profile where auth_user_id = $1", [owner.authUserId])).rows[0].id;
    const projectId = await createProjectViaApi(page, "Reviewed Apply");
    const { runId, body } = await completedRun(page, database, projectId);
    const base = `/api/projects/${projectId}/ai-runs/${runId}`;
    const view = await (await page.request.get(base)).json();
    expect(view).toMatchObject({ applicability: "APPLICABLE", applicabilityReasons: [], result: reviewedProposal, diff: { selectedOperationIds: ["flow", "step"] }, application: null });
    expect(view.diff.after.nodes[0]).toMatchObject({ label: "Pay", readOnly: false });
    for (const extra of [{ operations: reviewedProposal.operations }, { sourcePreconditions: [] }, { graph: {} }, { key: randomUUID() }]) {
      const refused = await page.request.post(`${base}/apply`, { headers: mutation(), data: { ...body, ...extra } });
      expect(refused.status()).toBe(400); expect(await errorOf(refused)).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    }
    expect((await page.request.post(`${base}/apply`, { headers: { Origin: appUrl }, data: body })).status()).toBe(400);
    expect((await page.request.post(`${base}/apply`, { headers: { ...mutation(), "Content-Type": "text/plain" }, data: JSON.stringify(body) })).status()).toBe(400);
    const over = await page.request.post(`${base}/apply`, { headers: mutation(), data: { ...body, operations: "x".repeat(17_000) } });
    expect(over.status()).toBe(413); expect(await errorOf(over)).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "APPLY_BODY_BYTES" } });
    const cookie = (await page.context().cookies(appUrl)).map(({ name, value }) => `${name}=${value}`).join("; ");
    expect((await chunkedPost(`${base}/apply`, cookie, Buffer.from(JSON.stringify({ ...body, operations: "x".repeat(17_000) })))).status).toBe(413);
    const hash = await page.request.post(`${base}/apply`, { headers: mutation(), data: { ...body, resultHash: "b".repeat(64) } });
    expect(hash.status()).toBe(409); expect((await errorOf(hash)).code).toBe("AI_RESULT_MISMATCH");
    const dependent = await page.request.post(`${base}/apply`, { headers: mutation(), data: { ...body, selectedOperationIds: ["step"] } });
    expect(dependent.status()).toBe(422); expect((await errorOf(dependent)).code).toBe("DEPENDENCY_CONFLICT");
    const stale = await page.request.post(`${base}/apply`, { headers: mutation(), data: { ...body, expectedDocumentRevision: body.expectedDocumentRevision + 1 } });
    expect(stale.status()).toBe(409); expect((await errorOf(stale)).code).toBe("STALE_DOCUMENT_REVISION");
    const foreignProject = await createProjectViaApi(page, "Foreign Apply");
    expect((await page.request.post(`/api/projects/${foreignProject}/ai-runs/${runId}/apply`, { headers: mutation(), data: body })).status()).toBe(404);
    const stranger = await strangerContext.newPage(); await signIn(stranger, admin, users, "Apply stranger");
    expect((await stranger.request.post(`${base}/apply`, { headers: mutation(), data: body })).status()).toBe(404);
    const viewer = await viewerContext.newPage(); const reader = await signIn(viewer, admin, users, "Apply viewer");
    const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: reader.email, role: "VIEWER" } });
    expect(invitation.status()).toBe(201);
    expect((await viewer.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } })).status()).toBe(201);
    expect((await viewer.request.post(`${base}/apply`, { headers: mutation(), data: body })).status()).toBe(403);
    expect((await viewer.request.post(`${base}/discard`, { headers: mutation(), data: { expectedResultHash: body.resultHash } })).status()).toBe(403);
    expect((await database.query("select count(*)::int n from app.ai_suggestion_application where run_id = $1", [runId])).rows[0].n).toBe(0);

    // Forward the real browser POST, wait for its committed 200, then lose only the response delivered to the browser.
    const key = randomUUID(); const acknowledgement = { value: null as Record<string, unknown> | null };
    const url = `${appUrl}${base}/apply`;
    await page.route(url, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); acknowledgement.value = await response.json(); await route.abort("failed"); });
    await page.goto(`/app/projects/${projectId}`);
    const lost = await page.evaluate(async ({ url, body, key }) => {
      try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }); return false; } catch { return true; }
    }, { url, body, key });
    expect(lost).toBe(true); expect(acknowledgement.value).not.toBeNull(); await page.unroute(url);
    const replay = await page.request.post(`${base}/apply`, { headers: mutation(key), data: body });
    expect(replay.status()).toBe(200); expect(replay.headers()["cache-control"]).toContain("no-store"); expect(await replay.json()).toEqual({ ...acknowledgement.value, replayed: true });
    const consumed = await page.request.post(`${base}/apply`, { headers: mutation(), data: body });
    expect(consumed.status()).toBe(409); expect(await errorOf(consumed)).toMatchObject({ code: "AI_RUN_CONSUMED", retryable: false, details: { runId, applicationId: acknowledgement.value!.applicationId } });
    const historical = await (await page.request.get(base)).json();
    expect(historical).toMatchObject({ disposition: "APPLIED", applicability: "UNAVAILABLE", applicabilityReasons: ["APPLIED"], application: { id: acknowledgement.value!.applicationId, selectedOperations: reviewedProposal.operations } });
    expect((await database.query("select count(*)::int n from app.ai_suggestion_application where run_id = $1", [runId])).rows[0].n).toBe(1);
    expect((await database.query("select count(*)::int n from app.audit_event where project_id = $1 and action = 'AI_PROPOSAL_APPLIED'", [projectId])).rows[0].n).toBe(1);
  } finally {
    await page.unrouteAll({ behavior: "wait" }); await viewerContext.close(); await strangerContext.close();
    await cleanupUsers(database, admin, users, page);
    if (ownerProfile) await database.query("delete from app.rate_limit_bucket where subject_hash = $1", [subjectOf(ownerProfile)]);
    await database.end();
  }
});

test("Discard recovers by key after downgrade and archive but current access still gates the receipt", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const admin = adminClient(), database = await openDatabase(), users: string[] = [];
  const editorContext = await browser.newContext(); let ownerProfile: string | null = null;
  try {
    const owner = await signIn(page, admin, users, "Discard owner"); await entitle(database, owner.authUserId);
    ownerProfile = (await database.query("select id from app.user_profile where auth_user_id = $1", [owner.authUserId])).rows[0].id;
    const projectId = await createProjectViaApi(page, "Reviewed Discard");
    const editorPage = await editorContext.newPage(); const editor = await signIn(editorPage, admin, users, "Discard editor");
    const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
    expect(invitation.status()).toBe(201);
    expect((await editorPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } })).status()).toBe(201);
    const { runId, body } = await completedRun(page, database, projectId), key = randomUUID();
    const base = `/api/projects/${projectId}/ai-runs/${runId}`, data = { expectedResultHash: body.resultHash };
    expect((await editorPage.request.post(`${base}/discard`, { headers: mutation(), data: { ...data, operations: [] } })).status()).toBe(400);
    const large = await editorPage.request.post(`${base}/discard`, { headers: mutation(), data: { ...data, text: "x".repeat(17_000) } });
    expect(large.status()).toBe(413); expect(await errorOf(large)).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "DISCARD_BODY_BYTES" } });
    const first = await editorPage.request.post(`${base}/discard`, { headers: mutation(key), data });
    expect(first.status()).toBe(200); expect(first.headers()["cache-control"]).toContain("no-store"); const result = await first.json();
    expect(result).toMatchObject({ runId, disposition: "DISCARDED", replayed: false });
    expect((await editorPage.request.post(`${base}/discard`, { headers: mutation(), data })).status()).toBe(409);
    await database.query("update app.project_membership set role = 'VIEWER' where project_id = $1 and profile_id = (select id from app.user_profile where auth_user_id = $2)", [projectId, editor.authUserId]);
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [projectId]);
    expect(await (await editorPage.request.post(`${base}/discard`, { headers: mutation(key), data })).json()).toEqual({ ...result, replayed: true });
    const history = await (await editorPage.request.get(base)).json(); expect(history).toMatchObject({ disposition: "DISCARDED", applicabilityReasons: ["DISCARDED"], result: reviewedProposal, application: null });
    await database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = (select id from app.user_profile where auth_user_id = $2)", [projectId, editor.authUserId]);
    expect((await editorPage.request.post(`${base}/discard`, { headers: mutation(key), data })).status()).toBe(404);
    expect((await editorPage.request.get(base)).status()).toBe(404);
    expect((await database.query("select count(*)::int n from app.audit_event where project_id = $1 and action = 'AI_PROPOSAL_DISCARDED'", [projectId])).rows[0].n).toBe(1);
  } finally {
    await editorContext.close(); await cleanupUsers(database, admin, users, page);
    if (ownerProfile) await database.query("delete from app.rate_limit_bucket where subject_hash = $1", [subjectOf(ownerProfile)]);
    await database.end();
  }
});

test("ten usable proposals return the HTTP capacity envelope while a later document head frees the limit", async ({ page }) => {
  test.setTimeout(120_000);
  const admin = adminClient(), database = await openDatabase(), users: string[] = []; let ownerProfile: string | null = null;
  try {
    const owner = await signIn(page, admin, users, "Capacity owner"); await entitle(database, owner.authUserId);
    ownerProfile = (await database.query("select id from app.user_profile where auth_user_id = $1", [owner.authUserId])).rows[0].id;
    const projectId = await createProjectViaApi(page, "Applicable capacity");
    for (let i = 0; i < 10; i++) await completedRun(page, database, projectId);
    const draft = (await database.query("select current_draft_id id from app.project where id = $1", [projectId])).rows[0];
    const input = { taskType: "PROPOSE_FLOW", prompt: "Another proposal", draftId: draft.id, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } };
    const refused = await page.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: input });
    expect(refused.status()).toBe(422); expect(await errorOf(refused)).toMatchObject({ code: "LIMIT_EXCEEDED", retryable: false, details: { limit: "APPLICABLE_PROPOSALS" } });
    await database.query("update app.scope_draft set document_revision = document_revision + 1 where id = $1", [draft.id]);
    expect((await page.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: { ...input, expectedDocumentRevision: 2 } })).status()).toBe(202);
  } finally {
    await cleanupUsers(database, admin, users, page);
    if (ownerProfile) await database.query("delete from app.rate_limit_bucket where subject_hash = $1", [subjectOf(ownerProfile)]);
    await database.end();
  }
});
