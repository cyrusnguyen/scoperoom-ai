import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { StartRunInput, ValidatedProposal } from "../../src/features/proposals/contracts/tasks";
import { expect } from "@playwright/test";
import { canonicalJson, sha256 } from "../../src/features/proposals/domain/capture";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { closeStudioContext, test } from "./studio-fixtures";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, entitle, e2eReady, seedStudioChanges, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const mutation = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const panel = (page: Page) => page.locator("#right-panel");
const warnsBeforeUnload = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});
const proposal: ValidatedProposal = { schemaVersion: 1, kind: "proposal", operations: [
  { id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW", payload: { ref: "flow", title: "Reviewed checkout", purpose: "A clear checkout", classification: "USER_JOURNEY", inclusion: "INCLUDED" } } },
  { id: "step", dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: "step", flowId: "flow", kind: "ACTION", label: "Pay", description: "Take payment", actorLabel: "Customer" } } },
], assumptions: ["The customer has a valid payment method."], citations: [] };

/** This advances only test SQL state after real admission. It is not a worker or model execution. */
async function storedSyntheticCompletion(page: Page, database: Client, projectId: string, expired = false, result: ValidatedProposal = proposal, selection: StartRunInput["context"]["selection"] = null) {
  const draft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number } }).draft;
  const prompt = `Synthetic reviewed proposal ${randomUUID()}`;
  const start = await page.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: {
    taskType: selection ? "REFINE_FLOW_SELECTION" : "PROPOSE_FLOW", prompt, draftId: draft.id, expectedDocumentRevision: draft.documentRevision,
    expectedParentSnapshotId: null, context: { selection, sources: [] },
  } });
  expect(start.status()).toBe(202);
  const runId = (await start.json() as { runId: string }).runId;
  const resultHash = sha256(canonicalJson(result));
  await database.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [runId]);
  await database.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', terminal_at = CASE WHEN $4 THEN now() - interval '8 days' ELSE now() END, result = $2::jsonb, result_hash = $3 where id = $1", [runId, JSON.stringify(result), resultHash, expired]);
  await database.query("select app.record_ai_event((select project_id from app.ai_run where id = $1), $1, 'AI_RUN_SUCCEEDED', jsonb_build_object('testOnly', true))", [runId]);
  if (expired) {
    const expiration = await database.query("select * from app.expire_ai_run_bodies(false, 100)");
    expect(Number(expiration.rows[0]?.expiredResults)).toBeGreaterThan(0);
  }
  return { runId, resultHash, prompt, body: {
    draftId: draft.id, expectedDocumentRevision: draft.documentRevision, expectedParentSnapshotId: null, resultHash, selectedOperationIds: result.kind === "proposal" ? result.operations.map((operation) => operation.id) : [],
  } };
}

async function openAi(page: Page) {
  await page.locator(".editor-header").getByRole("button", { name: "AI", exact: true }).click();
  await expect(panel(page).getByRole("tab", { name: "AI", exact: true })).toHaveAttribute("aria-selected", "true");
}

async function revealRequestId(page: Page, runId: string) {
  const details = panel(page).locator(".ai-run-details");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await expect(details.locator("div").filter({ has: page.getByText("Request id", { exact: true }) }).locator("dd")).toHaveText(runId);
}

async function cleanupInvitedUsers(database: Client, admin: ReturnType<typeof adminClient>, users: string[], projectId: string, contexts: BrowserContext[] = []) {
  for (const context of contexts) await closeStudioContext(context);
  await database.query("delete from app.project where id = $1", [projectId]);
  await cleanupUsers(database, admin, users);
}

test("Generate from an empty project and restore the exact queued run from its URL", async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI empty project");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  const action = panel(page).getByLabel("Action", { exact: true });
  await action.selectOption("REFINE_FLOW_SELECTION");
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  let starts = 0;
  page.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") starts++; });
  await panel(page).getByLabel("Instruction").fill("Improve the customer journey");
  await panel(page).getByRole("button", { name: "Improve selection", exact: true }).click();
  await expect(panel(page).getByRole("status").filter({ hasText: "Select one or more steps" })).toBeVisible();
  expect(starts).toBe(0);
  await action.selectOption("PROPOSE_FLOW");
  const startedPromise = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  const started = await startedPromise;
  expect(started.status()).toBe(202);
  const requestBody = started.request().postDataJSON() as Record<string, unknown>;
  expect(requestBody).toMatchObject({ taskType: "PROPOSE_FLOW", prompt: "Improve the customer journey", expectedParentSnapshotId: null, context: { selection: null, sources: [] } });
  const runId = (await started.json() as { runId: string }).runId;
  await expect(page).toHaveURL(new RegExp(`[?&]run=${runId}(?:&|$)`));
  await expect(panel(page).getByText("Queued", { exact: true })).toBeVisible();
  await revealRequestId(page, runId);
  await page.reload();
  await expect(panel(page).getByRole("tab", { name: "AI", exact: true })).toHaveAttribute("aria-selected", "true");
  await revealRequestId(page, runId);
  await panel(page).getByText("Exact captured instruction and context", { exact: true }).click();
  await expect(panel(page).getByText("Improve the customer journey", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Cancel run…" })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/projects/${projectId}?run=${runId}`);
  await expect(panel(page).getByRole("tab", { name: "AI", exact: true })).toHaveAttribute("aria-selected", "true");
  await revealRequestId(page, runId);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await revealRequestId(page, runId);
  const aiTab = panel(page).getByRole("tab", { name: "AI", exact: true });
  await aiTab.focus();
  await aiTab.press("ArrowLeft");
  const detailsTab = panel(page).getByRole("tab", { name: "Details", exact: true });
  await expect(detailsTab).toBeFocused();
  await expect(detailsTab).toHaveAttribute("aria-selected", "true");
  await detailsTab.press("End");
  await expect(aiTab).toBeFocused();
  await expect(aiTab).toHaveAttribute("aria-selected", "true");
});

test("pending Start protects unload across project switches until the exact admission receipt is acknowledged", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI pending Start source");
  const otherId = await createProjectViaApi(page, "AI pending Start destination");
  await page.goto("/app/projects/" + projectId);
  await openAi(page);
  await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
  expect(await warnsBeforeUnload(page)).toBe(false);
  const startUrl = appUrl + "/api/projects/" + projectId + "/ai-runs";
  const sent: { key: string; body: unknown; bytes: string | null }[] = [];
  const responses: { runId: string; replayed: boolean }[] = [];
  await page.route(startUrl, async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    sent.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON(), bytes: route.request().postData() });
    const response = await route.fetch();
    expect(response.status()).toBe(sent.length === 1 ? 202 : 200);
    responses.push(await response.json() as { runId: string; replayed: boolean });
    if (sent.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  try {
    await panel(page).getByLabel("Instruction").fill("Capture this exact instruction");
    await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
    await expect(panel(page).getByRole("button", { name: "Retry this request", exact: true })).toBeVisible();
    await panel(page).getByLabel("Instruction").fill("Keep this newer instruction");
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await panel(page).getByRole("button", { name: "Close panel", exact: true }).click();
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.locator("#projects-nav").getByRole("button", { name: "AI pending Start destination", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/app/projects/" + otherId + "$"));
    await expect(page.getByRole("dialog", { name: /Unsaved changes/ })).toHaveCount(0);
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.locator("#projects-nav").getByRole("button", { name: "AI pending Start source", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/app/projects/" + projectId + "$"));
    await openAi(page);
    await expect(panel(page).getByLabel("Instruction")).toHaveValue("Keep this newer instruction");
    await panel(page).getByRole("button", { name: "Retry this request", exact: true }).click();
    await expect(panel(page).getByText("Queued", { exact: true })).toBeVisible();
    await expect.poll(() => warnsBeforeUnload(page)).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]!.key).toBeTruthy();
    expect(sent[0]!.body).toMatchObject({ prompt: "Capture this exact instruction" });
    expect(responses[0]!.replayed).toBe(false);
    expect(responses[1]).toEqual({ ...responses[0], replayed: true });
    await expect(panel(page).getByLabel("Instruction")).toHaveValue("Keep this newer instruction");
    const stored = await workerAccount.database.query("select count(*)::int runs from app.ai_run where project_id = $1", [projectId]);
    expect(stored.rows[0].runs).toBe(1);
  } finally { await page.unroute(startUrl); }
});

test("a second editor receives AI_BUSY without losing their instruction", async ({ page, browser, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI competing editors");
  const admin = adminClient(), users: string[] = [], editorContext = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  const secondPage = await editorContext.newPage();
  try {
    const editor = await signIn(secondPage, admin, users, "AI competing editor");
    const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
    expect(invitation.status()).toBe(201);
    const accepted = await secondPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } });
    expect(accepted.status()).toBe(201);
    await page.goto(`/app/projects/${projectId}`);
    await secondPage.goto(`/app/projects/${projectId}`);
    await openAi(page); await openAi(secondPage);
    await panel(page).getByLabel("Instruction").fill("First editor request");
    await panel(secondPage).getByLabel("Instruction").fill("Keep this losing text");
    const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
    const firstResponse = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
    await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
    expect((await firstResponse).status()).toBe(202);
    const losingResponse = secondPage.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
    await panel(secondPage).getByRole("button", { name: "Generate", exact: true }).click();
    const refused = await losingResponse;
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "AI_BUSY" } });
    await expect(panel(secondPage).getByLabel("Instruction")).toHaveValue("Keep this losing text");
    await expect(panel(secondPage).locator(".ai-message")).toContainText(/another|busy|run/i);
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
  } finally {
      await cleanupInvitedUsers(workerAccount.database, admin, users, projectId, [page.context(), editorContext]);
  }
});

test("typing during delayed admission keeps newer text and captures only the submitted instruction", async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI delayed admission");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  const statusUrl = `${appUrl}/api/projects/${projectId}/status`;
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let sawAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { sawAdmission = resolve; });
  await page.route(statusUrl, async (route) => { sawAdmission(); await hold; await route.fallback(); });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await panel(page).getByLabel("Instruction").fill("Text at click time");
  const started = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  await admissionStarted;
  await panel(page).getByLabel("Instruction").fill("Newer text typed while admission waits");
  release();
  const response = await started;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toMatchObject({ prompt: "Text at click time" });
  await expect(panel(page).getByLabel("Instruction")).toHaveValue("Newer text typed while admission waits");
  await page.unroute(statusUrl);
});

test("switching projects during admission prevents the old project request from being sent", async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI switched project");
  const nextProjectId = await createProjectViaApi(page, "AI next project");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  const statusUrl = `${appUrl}/api/projects/${projectId}/status`;
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let sawAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { sawAdmission = resolve; });
  await page.route(statusUrl, async (route) => { sawAdmission(); await hold; await route.fallback(); });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await panel(page).getByLabel("Instruction").fill("Do not send after project switch");
  let starts = 0;
  page.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") starts++; });
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  await admissionStarted;
  await page.goto(`/app/projects/${nextProjectId}`);
  release();
  await page.waitForTimeout(500);
  expect(starts).toBe(0);
  await page.unroute(statusUrl);
});

test("switching accounts during AI admission never sends the previous account's request", async ({ browser, workerAccount }) => {
  test.setTimeout(120_000);
  const admin = adminClient(), users: string[] = [];
  const context = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  let release = () => {};
  try {
  const source = await signIn(page, admin, users, "AI account switch source");
  await entitle(workerAccount.database, source.authUserId);
  const projectId = await createProjectViaApi(page, "AI account switch");
  await page.goto("/app/projects/" + projectId);
  await openAi(page);
  const statusUrl = appUrl + "/api/projects/" + projectId + "/status";
  const startUrl = appUrl + "/api/projects/" + projectId + "/ai-runs";
  let sawAdmission!: () => void, statusSettled!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const admissionStarted = new Promise<void>((resolve) => { sawAdmission = resolve; });
  const admissionSettled = new Promise<void>((resolve) => { statusSettled = resolve; });
  await page.route(statusUrl, async (route) => { sawAdmission(); await hold; await route.fallback(); statusSettled(); });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await panel(page).getByLabel("Instruction").fill("Keep this in the signed-out account");
  let starts = 0;
  page.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") starts++; });
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  await admissionStarted;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, admin, users, "AI account switch target");
  release();
  await admissionSettled;
  await page.waitForTimeout(250);
  expect(starts).toBe(0);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "No project open" })).toBeVisible();
  } finally {
    release();
    await context.close();
    await cleanupUsers(workerAccount.database, admin, users);
  }
});

test("removing an editor while AI admission waits prevents its request", async ({ page, browser, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI access loss");
  const admin = adminClient(), users: string[] = [];
  const editorContext = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  const editorPage = await editorContext.newPage();
  let release!: () => void, sawAdmission!: () => void, heldRequest: Request | undefined;
  let holdNextStatus = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const admissionStarted = new Promise<void>((resolve) => { sawAdmission = resolve; });
  const statusUrl = appUrl + "/api/projects/" + projectId + "/status", startUrl = appUrl + "/api/projects/" + projectId + "/ai-runs";
  try {
    const editor = await signIn(editorPage, admin, users, "AI removed editor");
    const invitation = await page.request.post("/api/projects/" + projectId + "/invitations", { headers: mutation(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
    expect(invitation.status()).toBe(201);
    const accepted = await editorPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } });
    expect(accepted.status()).toBe(201);
    await editorPage.goto("/app/projects/" + projectId);
    await openAi(editorPage);
    await editorPage.route(statusUrl, async (route) => {
      if (!holdNextStatus) { await route.fallback(); return; }
      holdNextStatus = false;
      heldRequest = route.request();
      sawAdmission();
      await hold;
      await route.fallback();
    });
    const authorityResponse = editorPage.waitForResponse((response) => response.request() === heldRequest);
    await editorPage.evaluate(() => window.dispatchEvent(new Event("blur")));
    await panel(editorPage).getByLabel("Instruction").fill("Do not send after access is removed");
    let starts = 0;
    editorPage.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") starts++; });
    holdNextStatus = true;
    await panel(editorPage).getByRole("button", { name: "Generate", exact: true }).click();
    await admissionStarted;
    const { members } = await (await page.request.get("/api/projects/" + projectId + "/members")).json() as { members: { profileId: string; version: number }[] };
    const { rows: [profile] } = await workerAccount.database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [editor.authUserId]);
    const member = members.find((item) => item.profileId === profile!.id)!;
    const removed = await page.request.delete("/api/projects/" + projectId + "/members/" + member.profileId, { headers: mutation(), data: { expectedMemberVersion: member.version } });
    expect(removed.status()).toBe(200);
    release();
    expect(heldRequest).toBeDefined();
    expect((await authorityResponse).status()).toBe(404);
    await expect(editorPage.getByRole("heading", { name: "Project unavailable" })).toBeVisible();
    expect(starts).toBe(0);
  } finally {
    release();
    await cleanupInvitedUsers(workerAccount.database, admin, users, projectId, [page.context(), editorContext]);
  }
});

test("Improve captures the saved selected steps after the person resolves inspector fields", async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI saved selection");
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Manual saved flow", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "Initial description", actorLabel: "Customer" }, proposedIds: [nodeId] },
  ]);
  await page.goto(`/app/projects/${projectId}`);
  await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
  await page.getByRole("checkbox", { name: "Select Pay", exact: true }).check();
  await page.locator(".editor-header").getByRole("button", { name: "Inspect" }).click();
  await panel(page).getByLabel("Description").fill("Saved manual payment behaviour");
  await openAi(page);
  await panel(page).getByLabel("Action", { exact: true }).selectOption("REFINE_FLOW_SELECTION");
  await panel(page).getByLabel("Instruction").fill("Make payment failure recoverable");
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  let writes = 0;
  page.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") writes++; });
  await panel(page).getByRole("button", { name: "Improve selection", exact: true }).click();
  await expect(panel(page).getByText("Resolve the unsaved fields in Details", { exact: false })).toBeVisible();
  expect(writes).toBe(0);
  await panel(page).getByRole("tab", { name: "Details" }).click();
  // Explicitly save the inspector buffer; the AI action itself never submits dirty field buffers.
  await expect(panel(page).getByLabel("Description")).toHaveValue("Saved manual payment behaviour");
  const bootstrap = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } };
  const changesUrl = `${appUrl}/api/projects/${projectId}/drafts/${bootstrap.draft.id}/changes`;
  await page.route(changesUrl, async (route) => route.request().method() === "POST" ? route.abort("failed") : route.fallback());
  await panel(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".studio-status")).toContainText(/couldn’t|not saved|refresh/i);
  await panel(page).getByRole("tab", { name: "AI", exact: true }).click();
  await panel(page).getByRole("button", { name: "Improve selection", exact: true }).click();
  await expect(panel(page).getByLabel("Instruction")).toHaveValue("Make payment failure recoverable");
  expect(writes).toBe(0);
  await page.unroute(changesUrl);
  const accepted = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Improve selection", exact: true }).click();
  await expect(page.locator(".studio-status")).toContainText("All changes saved");
  const response = await accepted;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toMatchObject({
    taskType: "REFINE_FLOW_SELECTION", prompt: "Make payment failure recoverable",
    context: { selection: { flowId, nodeIds: [nodeId] }, sources: [] },
  });
  const runId = (await response.json() as { runId: string }).runId;
  const view = await (await page.request.get(`/api/projects/${projectId}/ai-runs/${runId}`)).json() as { documentRevision: number; capture: { graph: { nodes: { id: string; description: string }[] } } };
  expect(view.capture.graph.nodes.find((node) => node.id === nodeId)?.description).toBe("Saved manual payment behaviour");
  expect(view.documentRevision).toBeGreaterThan(1);
});

test("a dependency-complete subset applies once and preserves a peer layout-only move", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI layout preservation");
  const flowId = randomUUID(), nodeId = randomUUID();
  const draftId = await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Existing journey", purpose: "Saved before AI", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Check", description: "Existing step", actorLabel: "Staff" }, proposedIds: [nodeId] },
  ]);
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  const bootstrap = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number; layout: { positions: Record<string, { x: number; y: number; version: number }> } } };
  const position = bootstrap.draft.layout.positions[nodeId]!;
  const moved = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/positions`, {
    headers: mutation(), data: { mode: "MOVE_NODES", flowId, items: [{ nodeId, expectedPositionVersion: position.version, x: 742, y: 351 }] },
  });
  expect(moved.status()).toBe(200);
  expect((await moved.json() as { layoutRevision: number }).layoutRevision).toBeGreaterThan(1);
  expect((await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { documentRevision: number } }).draft.documentRevision).toBe(bootstrap.draft.documentRevision);
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await panel(page).locator(`[data-run-id="${completed.runId}"]`).getByRole("button").click();
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  await review.getByRole("checkbox", { name: /create flow/i }).check();
  await expect(review.getByRole("heading", { name: "Full proposal context", exact: true })).toBeVisible();
  await expect(review.getByText("1 of 2 operations selected for Apply. Unchecked operations are context only.", { exact: true })).toBeVisible();
  await expect(review.getByRole("checkbox", { name: /add node.*Pay/i }).locator("..")).toContainText("Context only, not selected for Apply");
  await expect(review.getByRole("button", { name: "Apply selected changes" })).toBeEnabled();
  await review.getByRole("button", { name: "Apply selected changes" }).click();
  await expect(panel(page).getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toBeVisible();
  const after = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { flows: Record<string, { title: string }>; nodes: Record<string, unknown> }; layout: { positions: Record<string, { x: number; y: number }> } } };
  expect(Object.values(after.draft.document.flows).some((flow) => flow.title === "Reviewed checkout")).toBe(true);
  expect(Object.values(after.draft.document.nodes).some((node: unknown) => (node as { label?: string }).label === "Pay")).toBe(false);
  expect(after.draft.layout.positions[nodeId]).toMatchObject({ x: 742, y: 351 });
  const consumed = await page.request.post(`/api/projects/${projectId}/ai-runs/${completed.runId}/apply`, { headers: mutation(), data: { ...completed.body, selectedOperationIds: ["flow"] } });
  expect(consumed.status()).toBe(409);
  expect(await consumed.json()).toMatchObject({ error: { code: "AI_RUN_CONSUMED" } });
});

test("switching projects after an Apply is sent never shows its result in the next project", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI Apply project switch");
  const nextProjectId = await createProjectViaApi(page, "AI Apply destination");
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  await page.goto("/app/projects/" + projectId);
  await openAi(page);
  await panel(page).locator("[data-run-id=\"" + completed.runId + "\"]").getByRole("button").click();
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  const operations = review.getByRole("checkbox");
  await operations.nth(0).check();
  await operations.nth(1).check();
  const applyUrl = appUrl + "/api/projects/" + projectId + "/ai-runs/" + completed.runId + "/apply";
  let release!: () => void, sawApply!: () => void, applySettled!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const applyStarted = new Promise<void>((resolve) => { sawApply = resolve; });
  const requestSettled = new Promise<void>((resolve) => { applySettled = resolve; });
  await page.route(applyUrl, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    sawApply();
    await hold;
    try { await route.fulfill({ response }); } finally { applySettled(); }
  });
  try {
    await review.getByRole("button", { name: "Apply selected changes" }).click();
    await applyStarted;
    const nav = page.locator("#projects-nav");
    await nav.getByRole("button", { name: "AI Apply destination", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/app/projects/" + nextProjectId + "$"));
    release();
    await requestSettled;
    await expect(page.getByRole("heading", { name: "AI Apply destination" })).toBeVisible();
    await expect(page.getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toHaveCount(0);
    const updated = await (await page.request.get("/api/projects/" + projectId + "/bootstrap")).json() as { draft: { document: { flows: Record<string, { title: string }> } } };
    expect(Object.values(updated.draft.document.flows).some((flow) => flow.title === "Reviewed checkout")).toBe(true);
  } finally {
    release();
    await page.unroute(applyUrl);
  }
});

test("switching accounts after an Apply is sent cannot update the next account's UI", async ({ browser, workerAccount }) => {
  test.setTimeout(120_000);
  const admin = adminClient(), users: string[] = [];
  const context = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  let release = () => {};
  let projectId = "";
  try {
  const source = await signIn(page, admin, users, "AI Apply account source");
  await entitle(workerAccount.database, source.authUserId);
  projectId = await createProjectViaApi(page, "AI Apply account switch");
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  await page.goto("/app/projects/" + projectId);
  await openAi(page);
  await panel(page).locator("[data-run-id=\"" + completed.runId + "\"]").getByRole("button").click();
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  const operations = review.getByRole("checkbox");
  await operations.nth(0).check();
  await operations.nth(1).check();
  const applyUrl = appUrl + "/api/projects/" + projectId + "/ai-runs/" + completed.runId + "/apply";
  let sawApply!: () => void, delivered!: () => void;
  let applyStatus = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const applyStarted = new Promise<void>((resolve) => { sawApply = resolve; });
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route(applyUrl, async (route) => {
    const response = await route.fetch();
    applyStatus = response.status();
    expect(applyStatus).toBe(200);
    sawApply();
    await hold;
    try { await route.fulfill({ response }); } finally { delivered(); }
  });
  await review.getByRole("button", { name: "Apply selected changes" }).click();
  await applyStarted;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, admin, users, "AI Apply account switch target");
  release();
  await delivery;
  expect(applyStatus).toBe(200);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "No project open" })).toBeVisible();
  await expect(page.getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toHaveCount(0);
  } finally {
    release();
    if (projectId) await cleanupInvitedUsers(workerAccount.database, admin, users, projectId, [context]);
    else { await closeStudioContext(context); await cleanupUsers(workerAccount.database, admin, users); }
  }
});

test("an inspector buffer typed before Apply's covering read survives receipt-floor adoption", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI Apply preserves newer buffer");
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Manual journey", purpose: "Existing", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "Before Apply", actorLabel: "Customer" }, proposedIds: [nodeId] },
  ]);
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  const bootstrap = await (await page.request.get("/api/projects/" + projectId + "/bootstrap")).json() as { draft: { id: string } };
  const draftUrl = appUrl + "/api/projects/" + projectId + "/drafts/" + bootstrap.draft.id;
  await page.goto("/app/projects/" + projectId);
  await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
  await page.getByRole("checkbox", { name: "Select Pay", exact: true }).check();
  await page.locator(".editor-header").getByRole("button", { name: "Inspect" }).click();
  await expect(panel(page).getByLabel("Description")).toHaveValue("Before Apply");
  await openAi(page);
  await panel(page).locator("[data-run-id=\"" + completed.runId + "\"]").getByRole("button").click();
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  const operations = review.getByRole("checkbox");
  await operations.nth(0).check();
  await operations.nth(1).check();
  const applyUrl = appUrl + "/api/projects/" + projectId + "/ai-runs/" + completed.runId + "/apply";
  let applied = false, release!: () => void, sawRead!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const coveringRead = new Promise<void>((resolve) => { sawRead = resolve; });
  await page.route(applyUrl, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    applied = true;
    await route.fulfill({ response });
  });
  await page.route(draftUrl, async (route) => {
    if (applied && route.request().method() === "GET") { sawRead(); await hold; }
    await route.fallback();
  });
  try {
    const appliedMessage = page.waitForResponse((response) => response.url() === applyUrl);
    await review.getByRole("button", { name: "Apply selected changes" }).click();
    await coveringRead;
    await panel(page).getByRole("tab", { name: "Details", exact: true }).click();
    await panel(page).getByLabel("Description").fill("Newer unsaved behaviour");
    release();
    expect((await appliedMessage).status()).toBe(200);
    await expect(panel(page).getByLabel("Description")).toHaveValue("Newer unsaved behaviour");
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    const saved = await (await page.request.get("/api/projects/" + projectId + "/bootstrap")).json() as { draft: { document: { nodes: Record<string, { description: string }> } } };
    expect(saved.draft.document.nodes[nodeId]?.description).toBe("Before Apply");
  } finally {
    release();
    await page.unroute(applyUrl);
    await page.unroute(draftUrl);
  }
});

test("closing AI ends observation while a stored synthetic completion remains available on reopen", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI closed panel");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await panel(page).getByLabel("Instruction").fill("Run while the panel is closed");
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  const responsePromise = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  const started = await responsePromise;
  expect(started.status()).toBe(202);
  const runId = (await started.json() as { runId: string }).runId;
  await workerAccount.database.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [runId]);
  await workerAccount.database.query("select app.record_ai_event((select project_id from app.ai_run where id = $1), $1, 'AI_RUN_RUNNING', jsonb_build_object('testOnly', true))", [runId]);
  await page.reload();
  await expect(panel(page).getByText("Running", { exact: true })).toBeVisible();
  let detailReads = 0;
  page.on("request", (request) => { if (request.url().endsWith(`/ai-runs/${runId}`) && request.method() === "GET") detailReads++; });
  await panel(page).getByRole("button", { name: "Close panel" }).click();
  await expect(panel(page)).toBeHidden();
  const hash = sha256(canonicalJson(proposal));
  // Synthetic stored completion is test setup only, not evidence of real model or worker execution.
  await workerAccount.database.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [runId]);
  await workerAccount.database.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', terminal_at = now(), result = $2::jsonb, result_hash = $3 where id = $1", [runId, JSON.stringify(proposal), hash]);
  await workerAccount.database.query("select app.record_ai_event((select project_id from app.ai_run where id = $1), $1, 'AI_RUN_SUCCEEDED', jsonb_build_object('testOnly', true))", [runId]);
  const readsWhenClosed = detailReads;
  await page.waitForTimeout(2_500);
  expect(detailReads).toBe(readsWhenClosed);
  await page.locator(".editor-header").getByRole("button", { name: "AI", exact: true }).click();
  await expect(panel(page).getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(panel(page).locator(".proposal-diff")).toContainText("Reviewed checkout");
  await expect(page).toHaveURL(new RegExp(`[?&]run=${runId}(?:&|$)`));
  await page.reload();
  await expect(panel(page).getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(panel(page).locator(".proposal-diff")).toContainText("Reviewed checkout");
});

test("cancellation remains a request while manual editing stays available", async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI cancellation and failure");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await panel(page).getByLabel("Instruction").fill("Cancel this run");
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  const responsePromise = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  const started = await responsePromise;
  expect(started.status()).toBe(202);
  expect(await started.json()).toMatchObject({ state: "QUEUED" });
  await panel(page).getByRole("button", { name: "Cancel run…" }).click();
  await expect(panel(page).getByRole("status").filter({ hasText: "Cancellation requested" })).toBeVisible();
  await expect(panel(page).getByRole("status").filter({ hasText: "provider may still be finishing" })).toBeVisible();
  await expect(panel(page).getByRole("status").filter({ hasText: "usage is not refunded" })).toBeVisible();
  await page.locator(".editor-body").getByRole("button", { name: "New flow" }).click();
  await expect(page.getByRole("dialog", { name: "New flow" })).toBeVisible();
  await page.getByRole("dialog", { name: "New flow" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".editor-body").getByRole("button", { name: "New flow" })).toBeEnabled();
  await panel(page).getByRole("button", { name: "Regenerate with a fresh capture" }).click();
  await expect(panel(page).getByLabel("Instruction")).toHaveValue("Cancel this run");
  await expect(panel(page).locator(".ai-message")).toContainText("fresh saved context");
});

test("failed runs keep manual editing available and expired results retain read-only history", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI lifecycle history");
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await panel(page).getByLabel("Instruction").fill("A run that fails at the provider boundary");
  const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
  const responsePromise = page.waitForResponse((response) => response.url() === startUrl && response.request().method() === "POST");
  await panel(page).getByRole("button", { name: "Generate", exact: true }).click();
  const started = await responsePromise;
  expect(started.status()).toBe(202);
  const failedId = (await started.json() as { runId: string }).runId;
  await workerAccount.database.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [failedId]);
  const failure = await workerAccount.database.query("select app.finish_ai_run($1::uuid, 'FAILED'::app.ai_run_state, 'SYNTHETIC_FAILURE') as result", [failedId]);
  expect(failure.rows[0]?.result).toBe("SETTLED");
  await expect(panel(page).getByText("Failed", { exact: true })).toBeVisible();
  await expect(panel(page).getByText(/provider could not complete this run.*synthetic failure/i)).toBeVisible();
  await page.locator(".editor-body").getByRole("button", { name: "New flow" }).click();
  await expect(page.getByRole("dialog", { name: "New flow" })).toBeVisible();
  await page.getByRole("dialog", { name: "New flow" }).getByRole("button", { name: "Cancel" }).click();

  const expiredProjectId = await createProjectViaApi(page, "AI expired history");
  const expired = await storedSyntheticCompletion(page, workerAccount.database, expiredProjectId, true);
  await page.goto(`/app/projects/${expiredProjectId}?run=${expired.runId}`);
  await expect(panel(page).getByText("This result has expired", { exact: false })).toBeVisible();
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  await expect(review.getByRole("button", { name: "Apply selected changes" })).toHaveCount(0);
  await expect(panel(page).getByText("Exact captured instruction and context")).toHaveCount(0);
  await page.locator(".editor-body").getByRole("button", { name: "New flow" }).click();
  await expect(page.getByRole("dialog", { name: "New flow" })).toBeVisible();
});

test("uncertain Apply stays pinned to its run and a viewer sees read-only saved history", async ({ page, browser, workerAccount }) => {
  test.setTimeout(150_000);
  const projectId = await createProjectViaApi(page, "AI shared review");
  const first = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  const second = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  const history = panel(page).locator(".ai-history-item");
  await expect(history).toHaveCount(2);
  await history.nth(1).click();
  const proposalReview = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  const operations = proposalReview.getByRole("checkbox");
  await operations.nth(1).check();
  await expect(proposalReview.getByRole("alert")).toContainText("Also select required operations");
  await expect(proposalReview.getByRole("button", { name: "Apply selected changes" })).toBeDisabled();
  await operations.nth(0).check();
  await operations.nth(1).uncheck();
  const applyUrl = `${appUrl}/api/projects/${projectId}/ai-runs/${first.runId}/apply`;
  const sent: { key: string | undefined; body: unknown; bytes: string | null }[] = [];
  await page.route(applyUrl, async (route) => {
    const request = route.request();
    sent.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON(), bytes: request.postData() });
    if (sent.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  await proposalReview.getByRole("button", { name: "Apply selected changes" }).click();
  await expect(proposalReview.getByRole("button", { name: "Retry Apply with the same selection" })).toBeVisible();
  await history.nth(0).click();
  const otherReview = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  await expect(otherReview.getByRole("button", { name: "Apply selected changes" })).toBeDisabled();
  await history.nth(1).click();
  await panel(page).getByRole("tab", { name: "Details", exact: true }).click();
  await panel(page).getByRole("tab", { name: "AI", exact: true }).click();
  const pinnedReview = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  await expect(pinnedReview.getByRole("checkbox", { name: /create flow.*Reviewed checkout/i })).toBeChecked();
  await expect(pinnedReview.getByRole("checkbox", { name: /create flow.*Reviewed checkout/i })).toBeDisabled();
  await expect(pinnedReview.getByRole("checkbox", { name: /add node.*Pay/i })).not.toBeChecked();
  await expect(pinnedReview.getByRole("checkbox", { name: /add node.*Pay/i })).toBeDisabled();
  await expect(pinnedReview.getByText("1 of 2 operations selected for Apply. Unchecked operations are context only.", { exact: true })).toBeVisible();
  await expect(pinnedReview.getByRole("checkbox", { name: /add node.*Pay/i }).locator("..")).toContainText("Context only, not selected for Apply");
  expect(sent[0]?.body).toMatchObject({ selectedOperationIds: ["flow"] });
  await pinnedReview.getByRole("button", { name: "Retry Apply with the same selection" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  await expect(panel(page).getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toBeVisible();
  const bootstrap = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { flows: Record<string, { title: string }>; nodes: Record<string, unknown> } }; status: { approvedSnapshotId: string | null } };
  expect(Object.values(bootstrap.draft.document.flows).some((flow) => flow.title === "Reviewed checkout")).toBe(true);
  expect(bootstrap.draft.document.nodes).toEqual({});
  expect(bootstrap.status.approvedSnapshotId).toBeNull();
  await page.unroute(applyUrl);

  // Viewer history remains inspectable, while action controls are hidden even when the saved run freshness is APPLICABLE.
  const admin = adminClient();
  const viewerUsers: string[] = [];
  const viewerContext = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  const viewerPage = await viewerContext.newPage();
  try {
    const viewer = await signIn(viewerPage, admin, viewerUsers, "AI history viewer");
    const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: viewer.email, role: "VIEWER" } });
    expect(invitation.status()).toBe(201);
    const accepted = await viewerPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } });
    expect(accepted.status()).toBe(201);
    await viewerPage.goto(`/app/projects/${projectId}`);
    await openAi(viewerPage);
    await expect(panel(viewerPage).getByText("Read-only history.", { exact: false })).toBeVisible();
    const viewerReview = panel(viewerPage).getByRole("heading", { name: "Proposal review" }).locator("..");
    await expect(viewerReview.getByRole("button", { name: "Apply selected changes" })).toBeDisabled();
    await expect(panel(viewerPage).getByRole("button", { name: /Cancel run|Discard proposal|Regenerate with a fresh capture/ })).toHaveCount(0);
    await panel(viewerPage).getByText("Exact captured instruction and context").click();
    await expect(panel(viewerPage).getByText(second.prompt, { exact: true })).toBeVisible();
  } finally {
    await cleanupInvitedUsers(workerAccount.database, admin, viewerUsers, projectId, [page.context(), viewerContext]);
  }
});

test("archived owners can inspect history but cannot mutate it", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI archived history");
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  await workerAccount.database.query("update app.project set status = 'ARCHIVED' where id = $1", [projectId]);
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await expect(panel(page).getByRole("heading", { name: "Proposal review" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Apply selected changes" })).toBeDisabled();
  await expect(panel(page).getByRole("button", { name: /Cancel run|Discard proposal|Regenerate with a fresh capture/ })).toHaveCount(0);
  await expect(panel(page).getByText("Read-only history.", { exact: false })).toBeVisible();
  expect((await (await page.request.get(`/api/projects/${projectId}/ai-runs/${completed.runId}`)).json() as { applicability: string; applicabilityReasons: string[] })).toMatchObject({ applicability: "UNAVAILABLE", applicabilityReasons: ["PROJECT_INACTIVE"] });
});

test("a fixture-scoped baseline change stales a run without changing the saved document", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI baseline stale");
  const otherProjectId = await createProjectViaApi(page, "AI baseline negative control");
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  const before = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number; layoutRevision: number } };
  const database = workerAccount.database;
  const databaseTarget = new URL(process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL!);
  expect(databaseTarget.hostname).toBe("127.0.0.1");
  expect((await database.query("select environment_id::text id from app.environment_identity where id = 1")).rows[0]?.id).toBe(process.env.SCOPEROOM_ENVIRONMENT_ID);
  const definition = (await database.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid = 'app.project'::regclass and conname = 'project_baseline_pending_snapshots'")).rows[0]?.definition as string;
  let scoped = false;
  try {
    await database.query("begin");
    try {
      await database.query("alter table app.project drop constraint project_baseline_pending_snapshots");
      await database.query(`alter table app.project add constraint project_baseline_pending_snapshots CHECK ((id = '${projectId}'::uuid) OR ${definition.slice(6)})`);
      await database.query("commit");
      scoped = true;
    } catch (error) { await database.query("rollback"); throw error; }
    await assert.rejects(database.query("update app.project set approved_snapshot_id = $2 where id = $1", [otherProjectId, randomUUID()]), { code: "23514" });
    await database.query("update app.project set approved_snapshot_id = $2 where id = $1", [projectId, randomUUID()]);
    const view = await (await page.request.get(`/api/projects/${projectId}/ai-runs/${completed.runId}`)).json() as { applicability: string; applicabilityReasons: string[]; diff: unknown; documentRevision: number };
    expect(view.applicability).toBe("STALE");
    expect(view.applicabilityReasons).toContain("BASELINE_CHANGED");
    expect(view.documentRevision).toBe(before.draft.documentRevision);
    await page.goto(`/app/projects/${projectId}?run=${completed.runId}`);
    await expect(panel(page).getByText(/can’t be applied.*baseline changed/i)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Apply selected changes" })).toBeDisabled();
    expect((await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { documentRevision: number; layoutRevision: number } }).draft)
      .toMatchObject({ documentRevision: before.draft.documentRevision, layoutRevision: before.draft.layoutRevision });
  } finally {
    if (scoped) {
      await database.query("update app.project set approved_snapshot_id = null where id = $1", [projectId]);
      await database.query("begin");
      try {
        await database.query("alter table app.project drop constraint project_baseline_pending_snapshots");
        await database.query(`alter table app.project add constraint project_baseline_pending_snapshots ${definition}`);
        await database.query("commit");
      } catch (error) { await database.query("rollback"); throw error; }
      expect((await database.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid = 'app.project'::regclass and conname = 'project_baseline_pending_snapshots'")).rows[0]?.definition).toBe(definition);
    }
  }
});

test("review regression: Studio draft checks open Details after AI was selected", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "AI Inspect tab recovery");
  const flowId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Inspect this flow", purpose: "Review checks", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
  ]);
  await page.goto(`/app/projects/${projectId}`);
  await openAi(page);
  await page.locator(".studio-status").getByRole("button", { name: /draft checks|No draft checks/ }).click();
  await expect(panel(page).getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByLabel("Title", { exact: true })).toHaveValue("Inspect this flow");
});

for (const lateChange of ["typed buffer", "selection"] as const) {
  test(`review regression: ${lateChange} during final AI capture admission sends nothing`, async ({ page }) => {
    test.setTimeout(120_000);
    const projectId = await createProjectViaApi(page, `AI late ${lateChange}`);
    const flowId = randomUUID(), nodeId = randomUUID(), otherNodeId = randomUUID();
    const draftId = await seedStudioChanges(page, projectId, [
      { command: "CREATE_FLOW", payload: { title: "Late edit flow", purpose: "Saved context", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
      { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "Saved step", actorLabel: "Customer" }, proposedIds: [nodeId] },
      { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Receipt", description: "Saved next step", actorLabel: "Customer" }, proposedIds: [otherNodeId] },
    ]);
    await page.goto(`/app/projects/${projectId}`);
    if (lateChange === "selection") {
      await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
      await page.getByRole("checkbox", { name: "Select Pay", exact: true }).check();
    }
    await openAi(page);
    if (lateChange === "typed buffer") await page.locator(".studio-toolbar").getByRole("button", { name: "Canvas", exact: true }).click();
    if (lateChange === "selection") await panel(page).getByLabel("Action", { exact: true }).selectOption("REFINE_FLOW_SELECTION");
    await panel(page).getByLabel("Instruction").fill("Keep this instruction while context changes");
    const statusUrl = `${appUrl}/api/projects/${projectId}/status`;
    const draftUrl = `${appUrl}/api/projects/${projectId}/drafts/${draftId}`;
    const startUrl = `${appUrl}/api/projects/${projectId}/ai-runs`;
    let release!: () => void, sawFinalAdmission!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const finalAdmission = new Promise<void>((resolve) => { sawFinalAdmission = resolve; });
    let holdNextStatus = false, captured = false, starts = 0;
    page.on("request", (request) => { if (request.url() === startUrl && request.method() === "POST") starts++; });
    await page.route(statusUrl, async (route) => {
      if (!holdNextStatus) { await route.fallback(); return; }
      holdNextStatus = false;
      sawFinalAdmission();
      await hold;
      await route.fallback();
    });
    await page.route(draftUrl, async (route) => {
      const response = await route.fetch();
      if (!captured) {
        captured = true;
        holdNextStatus = true;
        // Force the final authority check to await a read after the saved capture was inspected.
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      }
      await route.fulfill({ response });
    });
    try {
      await panel(page).getByRole("button", { name: lateChange === "selection" ? "Improve selection" : "Generate", exact: true }).click();
      await finalAdmission;
      if (lateChange === "selection") {
        await page.getByRole("checkbox", { name: "Select Receipt", exact: true }).check();
      } else {
        await page.locator(`.react-flow__node[data-id="${nodeId}"] .step-label`).dblclick();
        await page.locator(".inline-edit textarea").fill("Newer unsaved step label");
      }
      release();
      await expect(panel(page).locator(".ai-message")).toContainText(/Studio edits changed|selected steps changed/i);
      expect(starts).toBe(0);
      await expect(panel(page).getByLabel("Instruction")).toHaveValue("Keep this instruction while context changes");
      if (lateChange === "typed buffer") {
        await expect(page.locator(".inline-edit textarea")).toHaveValue("Newer unsaved step label");
        await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
      } else await expect(page.getByRole("checkbox", { name: "Select Receipt", exact: true })).toBeChecked();
    } finally {
      release();
      await page.unroute(statusUrl);
      await page.unroute(draftUrl);
    }
  });
}

test("review regression: expired proposal still recovers an uncertain Apply with its original receipt", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI expired Apply recovery");
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId);
  await page.goto(`/app/projects/${projectId}?run=${completed.runId}`);
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  await review.getByRole("checkbox").nth(0).check();
  await review.getByRole("checkbox").nth(1).check();
  await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
  expect(await warnsBeforeUnload(page)).toBe(false);
  const applyUrl = `${appUrl}/api/projects/${projectId}/ai-runs/${completed.runId}/apply`;
  const sent: { key: string | undefined; body: unknown; bytes: string | null }[] = [];
  let replayed = false, lostAcknowledgement!: () => void;
  const lost = new Promise<void>((resolve) => { lostAcknowledgement = resolve; });
  await page.route(applyUrl, async (route) => {
    sent.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON(), bytes: route.request().postData() });
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (sent.length === 1) { await route.abort("failed"); lostAcknowledgement(); }
    else {
      replayed = (await response.json() as { replayed: boolean }).replayed;
      await route.fulfill({ response });
    }
  });
  try {
    await review.getByRole("button", { name: "Apply selected changes" }).click();
    await lost;
    await expect(review.getByRole("button", { name: "Retry Apply with the same selection" })).toBeVisible();
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
    expect(await warnsBeforeUnload(page)).toBe(true);
    const applied = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { documentRevision: number; layoutRevision: number; document: { flows: Record<string, { title: string }> } } };
    expect(Object.values(applied.draft.document.flows).filter((flow) => flow.title === "Reviewed checkout")).toHaveLength(1);
    const databaseTarget = new URL(process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL!);
    expect(databaseTarget.hostname).toBe("127.0.0.1");
    expect((await workerAccount.database.query("select environment_id::text id from app.environment_identity where id = 1")).rows[0]?.id).toBe(process.env.SCOPEROOM_ENVIRONMENT_ID);
    // Project-scoped historical aging fixture. LOCAL replica mode resets at transaction end.
    await workerAccount.database.query("begin");
    try {
      await workerAccount.database.query("set local session_replication_role = replica");
      await workerAccount.database.query("update app.ai_run set terminal_at = now() - interval '8 days' where id = $1", [completed.runId]);
      await workerAccount.database.query("commit");
    } catch (error) { await workerAccount.database.query("rollback"); throw error; }
    expect((await workerAccount.database.query("show session_replication_role")).rows[0]?.session_replication_role).toBe("origin");
    const expired = await workerAccount.database.query("select * from app.expire_ai_run_bodies(false, 100)");
    expect(Number(expired.rows[0]?.clearedBodies)).toBeGreaterThan(0);
    const cleaned = await (await page.request.get(`/api/projects/${projectId}/ai-runs/${completed.runId}`)).json();
    expect(cleaned).toMatchObject({ disposition: "APPLIED", capture: null, result: null, application: { runId: completed.runId } });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(review.getByText("No proposal is available for this run.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(review.getByRole("button", { name: "Apply selected changes" })).toHaveCount(0);
    await expect(review.getByRole("button", { name: "Retry Apply with the same selection" })).toBeVisible();
    await review.getByRole("button", { name: "Retry Apply with the same selection" }).click();
    await expect(panel(page).getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(replayed).toBe(true);
    await expect.poll(() => warnsBeforeUnload(page)).toBe(false);
    const recovered = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as typeof applied;
    expect(recovered.draft).toEqual(applied.draft);
    const freshApply = await page.request.post(applyUrl, { headers: mutation(), data: completed.body });
    expect(freshApply.status()).toBe(409);
    expect(await freshApply.json()).toMatchObject({ error: { code: "AI_RUN_CONSUMED" } });
  } finally { await page.unroute(applyUrl); }
});


test("corrective regression: two node updates identify their target and fields before subset Apply", async ({ page, workerAccount }) => {
  test.setTimeout(120_000);
  const projectId = await createProjectViaApi(page, "AI distinguish node updates");
  const paymentLabel = "Pay for the customer order " + "longname".repeat(16);
  const flowId = randomUUID(), paymentId = randomUUID(), receiptId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Saved flow", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: paymentLabel, description: "Original payment", actorLabel: "Customer" }, proposedIds: [paymentId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Receipt", description: "Original receipt", actorLabel: "Customer" }, proposedIds: [receiptId] },
  ]);
  const paymentDescription = "Retry payment safely <img src=x onerror=alert(1)> " + "x".repeat(140);
  const result: ValidatedProposal = { schemaVersion: 1, kind: "proposal", operations: [
    { id: "first", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: paymentId, description: paymentDescription } } },
    { id: "second", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: receiptId, label: "Send receipt", actorLabel: "Staff" } } },
  ], assumptions: [], citations: [] };
  const completed = await storedSyntheticCompletion(page, workerAccount.database, projectId, false, result, { flowId, nodeIds: [paymentId, receiptId] });
  const before = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { nodes: Record<string, { description: string }> } } };
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/app/projects/${projectId}?run=${completed.runId}`);
  const review = panel(page).getByRole("heading", { name: "Proposal review" }).locator("..");
  const payment = review.getByRole("checkbox", { name: /update node.*Pay.*Behaviour.*Retry payment safely/i });
  const receipt = review.getByRole("checkbox", { name: /update node.*Receipt.*Step.*Send receipt.*Actor.*Staff/i });
  await expect(payment).toBeVisible(); await expect(receipt).toBeVisible();
  await expect(payment.locator("..")).toContainText(paymentDescription);
  await expect(review.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const runDetails = panel(page).locator(".ai-run-details summary");
  await runDetails.focus();
  await expect(runDetails).toBeFocused();
  await expect(panel(page).locator(".ai-run-details")).not.toHaveAttribute("open", "");
  await runDetails.press("Enter");
  await expect(panel(page).locator(".ai-run-details")).toHaveAttribute("open", "");
  await revealRequestId(page, completed.runId);
  await panel(page).locator(".ai-capture summary").click();
  await review.locator(".proposal-diff > details").first().locator(":scope > summary").click();
  await expect(panel(page)).toHaveAttribute("data-dock", "overlay");
  expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel(page)).toHaveAttribute("data-dock", "docked");
  expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel(page)).toHaveAttribute("data-dock", "overlay");
  await payment.focus();
  await expect(payment).toBeFocused();
  await payment.press("Space");
  await expect(payment).toBeChecked();
  await expect(receipt).not.toBeChecked();
  await expect(review.getByText("1 of 2 operations selected for Apply. Unchecked operations are context only.", { exact: true })).toBeVisible();
  const applyUrl = `${appUrl}/api/projects/${projectId}/ai-runs/${completed.runId}/apply`;
  const appliedPromise = page.waitForResponse((response) => response.url() === applyUrl && response.request().method() === "POST");
  await review.getByRole("button", { name: "Apply selected changes" }).click();
  const applied = await appliedPromise;
  expect(applied.status()).toBe(200);
  expect(applied.request().postDataJSON()).toMatchObject({ selectedOperationIds: ["first"] });
  await expect(panel(page).getByText("Selected changes applied to the draft. They are not approved.", { exact: true })).toBeVisible();
  const after = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as typeof before;
  expect(after.draft.document.nodes[paymentId]?.description).toBe(paymentDescription);
  expect(after.draft.document.nodes[receiptId]).toEqual(before.draft.document.nodes[receiptId]);
});

for (const kind of ["cancel", "discard"] as const) for (const accessChange of ["downgrade", "archive"] as const) {
  test(`corrective regression: pending ${kind} recovers after ${accessChange} with current membership only`, async ({ page, browser, workerAccount }) => {
    test.setTimeout(120_000);
    const projectId = await createProjectViaApi(page, `AI ${kind} ${accessChange} recovery`);
    const admin = adminClient(), users: string[] = [];
    const editorContext = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
    const editorPage = await editorContext.newPage();
    try {
      const editor = await signIn(editorPage, admin, users, "AI control retry editor");
      const invitation = await page.request.post(`/api/projects/${projectId}/invitations`, { headers: mutation(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
      expect(invitation.status()).toBe(201);
      expect((await editorPage.request.post("/api/invitations/accept", { headers: mutation(), data: { token: (await invitation.json() as { url: string }).url.split("/").at(-1) } })).status()).toBe(201);
      let runId: string;
      if (kind === "discard") runId = (await storedSyntheticCompletion(editorPage, workerAccount.database, projectId)).runId;
      else {
        const draft = (await (await editorPage.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number } }).draft;
        const admitted = await editorPage.request.post(`/api/projects/${projectId}/ai-runs`, { headers: mutation(), data: {
          taskType: "PROPOSE_FLOW", prompt: "Cancel exact request", draftId: draft.id, expectedDocumentRevision: draft.documentRevision,
          expectedParentSnapshotId: null, context: { selection: null, sources: [] },
        } });
        expect(admitted.status()).toBe(202); runId = (await admitted.json() as { runId: string }).runId;
      }
      await editorPage.goto(`/app/projects/${projectId}?run=${runId}`);
      const controlUrl = `${appUrl}/api/projects/${projectId}/ai-runs/${runId}/${kind}`;
      const sent: { key: string; body: Record<string, unknown>; bytes: string | null }[] = [];
      const responses: Record<string, unknown>[] = [];
      let lostAcknowledgement!: () => void;
      const lost = new Promise<void>((resolve) => { lostAcknowledgement = resolve; });
      await editorPage.route(controlUrl, async (route) => {
        sent.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() as Record<string, unknown>, bytes: route.request().postData() });
        const response = await route.fetch(); expect(response.status()).toBe(200);
        responses.push(await response.json() as Record<string, unknown>);
        if (sent.length === 1) { await route.abort("failed"); lostAcknowledgement(); }
        else await route.fulfill({ response });
      });
      const auditAction = kind === "cancel" ? "AI_RUN_CANCEL_REQUESTED" : "AI_PROPOSAL_DISCARDED";
      const snapshot = async () => (await workerAccount.database.query(`select r.state, r.disposition, r.cancel_requested_at, r.budget_state, r.last_event_sequence, p.ai_revision,
        (select count(*)::int from app.mutation_receipt where scope_id = p.id and key = $3) receipts,
        (select count(*)::int from app.audit_event where project_id = p.id and action = $4) audits
        from app.ai_run r join app.project p on p.id = r.project_id where r.id = $1 and p.id = $2`, [runId, projectId, sent[0]?.key ?? "not-yet-sent", auditAction])).rows[0];
      expect(await snapshot()).toMatchObject({ receipts: 0, audits: 0 });
      await expect(editorPage.locator(".studio-status")).not.toContainText("Unsaved changes");
      expect(await warnsBeforeUnload(editorPage)).toBe(false);
      await panel(editorPage).getByRole("button", { name: kind === "cancel" ? "Cancel run…" : "Discard proposal", exact: true }).click();
      await lost;
      const retry = panel(editorPage).getByRole("button", { name: `Retry ${kind}`, exact: true });
      await expect(retry).toBeVisible();
      await expect(editorPage.locator(".studio-status")).not.toContainText("Unsaved changes");
      expect(await warnsBeforeUnload(editorPage)).toBe(true);
      expect(responses[0]).toMatchObject(kind === "cancel" ? { runId, cancelRequested: true, replayed: false } : { runId, disposition: "DISCARDED", replayed: false });
      const committed = await snapshot();
      expect(committed).toMatchObject({ receipts: 1, audits: 1 });
      if (kind === "cancel") { expect(committed.state).toBe("QUEUED"); expect(committed.cancel_requested_at).not.toBeNull(); expect(committed.budget_state).toBe("RESERVED"); }
      else expect(committed.disposition).toBe("DISCARDED");
      const member = async () => {
        const members = (await (await page.request.get(`/api/projects/${projectId}/members`)).json() as { members: { profileId: string; version: number }[] }).members;
        const profileId = (await workerAccount.database.query("select id from app.user_profile where auth_user_id = $1", [editor.authUserId])).rows[0].id as string;
        return members.find((item) => item.profileId === profileId)!;
      };
      if (accessChange === "downgrade") {
        const current = await member();
        expect((await page.request.patch(`/api/projects/${projectId}/members/${current.profileId}`, { headers: mutation(), data: { role: "VIEWER", expectedMemberVersion: current.version } })).status()).toBe(200);
      } else {
        const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { version: number };
        expect((await page.request.post(`/api/projects/${projectId}/archive`, { headers: mutation(), data: { expectedProjectVersion: status.version, reason: "Control receipt recovery" } })).status()).toBe(200);
      }
      await editorPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(panel(editorPage).getByText("Read-only history.", { exact: false })).toBeVisible({ timeout: 15_000 });
      await expect(panel(editorPage).getByRole("button", { name: /Cancel run|Discard proposal|Regenerate with a fresh capture/ })).toHaveCount(0);
      await expect(panel(editorPage).getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
      await expect(retry).toBeEnabled();
      expect(await warnsBeforeUnload(editorPage)).toBe(true);
      const beforeReplay = await snapshot();
      expect(beforeReplay).toEqual(committed);
      await retry.click();
      await expect(panel(editorPage).locator(".ai-message")).toContainText(kind === "cancel" ? "Cancellation requested" : "Run discarded");
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect(responses[1]).toEqual({ ...responses[0], replayed: true });
      await expect.poll(() => warnsBeforeUnload(editorPage)).toBe(false);
      expect(await snapshot()).toEqual(beforeReplay);
      // Removal still refuses the exact saved receipt without returning the successful result.
      await workerAccount.database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = (select id from app.user_profile where auth_user_id = $2)", [projectId, editor.authUserId]);
      const refusalRequestId = randomUUID();
      const denied = await editorPage.request.post(controlUrl, { headers: { Origin: appUrl, "Idempotency-Key": sent[0]!.key, "X-Request-Id": refusalRequestId }, data: sent[0]!.body });
      expect(denied.status()).toBe(404);
      const denial = await denied.json() as { error: { code: string } };
      expect(denial.error.code).toBe("NOT_FOUND");
      const unknownRun = await editorPage.request.post(`${appUrl}/api/projects/${projectId}/ai-runs/${randomUUID()}/${kind}`, { headers: { ...mutation(), "X-Request-Id": refusalRequestId }, data: sent[0]!.body });
      expect(unknownRun.status()).toBe(404); expect(await unknownRun.json()).toEqual(denial);
      expect((await editorPage.request.get(`/api/projects/${projectId}/ai-runs/${runId}`)).status()).toBe(404);
      expect(await snapshot()).toEqual(beforeReplay);
      await editorPage.unroute(controlUrl);
    } finally { await cleanupInvitedUsers(workerAccount.database, admin, users, projectId, [page.context(), editorContext]); }
  });
}
