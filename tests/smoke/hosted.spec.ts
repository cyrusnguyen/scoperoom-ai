import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

// One serial journey against a deployed target with pre-created synthetic accounts. Public HTTP and the browser only:
// no database URL and no Supabase secret key. The only fixtures are this run's projects, archived in afterAll.
type Role = "OWNER" | "EDITOR" | "VIEWER";
const origin = new URL(process.env.SMOKE_URL!).origin;
const runId = randomUUID().slice(0, 8);
const created: { id: string; archived: boolean }[] = [];
const ledger = `.tmp/smoke/${runId}.json`;
let owner: Page | undefined;

const headers = () => ({ Origin: origin, "Idempotency-Key": randomUUID() });
const nodeAt = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const saveLedger = () => { mkdirSync(".tmp/smoke", { recursive: true }); writeFileSync(ledger, `${JSON.stringify({ runId, origin, created }, null, 2)}\n`); };

async function signIn(browser: Browser, role: Role) {
  const email = process.env[`SMOKE_${role}_EMAIL`], password = process.env[`SMOKE_${role}_PASSWORD`];
  if (!email || !password) throw new Error(`Smoke needs SMOKE_${role}_EMAIL and SMOKE_${role}_PASSWORD.`);
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login"); // support.ts signIn, without the admin-created user
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  expect((await page.request.get("/api/me")).status()).toBe(200);
  return page;
}
async function send(page: Page, method: "post" | "patch" | "delete", path: string, data: unknown, expected: number) {
  const response = await page.request[method](path, { headers: headers(), data });
  expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(expected);
  return response.json();
}
async function read(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.status(), `GET ${path}`).toBe(200);
  return response.json();
}
type RunView = {
  state: string; failureCode?: string; applicability?: string; draftId: string; documentRevision: number; parentSnapshotId: string | null; resultHash: string;
  result?: { kind: "proposal"; operations: { id: string }[] } | { kind: "clarification" };
};
async function waitForRun(page: Page, projectId: string, runId: string) {
  let run = {} as RunView;
  await expect.poll(async () => (run = await read(page, `/api/projects/${projectId}/ai-runs/${runId}`)).state, { timeout: 330_000, intervals: [5_000] })
    .toMatch(/^(SUCCEEDED|FAILED|CANCELLED|TIMED_OUT)$/);
  return run;
}

test.afterAll(async () => {
  try {
    for (const project of created) {
      if (!owner || project.archived) continue;
      const status = await read(owner, `/api/projects/${project.id}/status`);
      await send(owner, "post", `/api/projects/${project.id}/archive`, { expectedProjectVersion: status.version, reason: `Smoke ${runId} cleanup` }, 200);
      project.archived = true;
      // Archive fences AI: admission on an archived project is refused before any model call.
      const refused = await owner.request.post(`/api/projects/${project.id}/ai-runs`, { headers: headers(), data: { taskType: "PROPOSE_FLOW", prompt: "Smoke", draftId: status.currentDraftId, expectedDocumentRevision: status.documentRevision, expectedParentSnapshotId: status.approvedSnapshotId, context: { selection: null, sources: [] } } });
      expect(refused.status()).not.toBe(202);
    }
  } finally {
    saveLedger(); // the operator's cleanup record, even when an archive fails
  }
});

test("hosted pilot smoke", async ({ browser }) => {
  await test.step("target answers as ScopeRoom", async () => {
    const health = await (await browser.newContext()).request.get(`${origin}/api/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "scoperoom-ai" });
  });

  owner = await signIn(browser, "OWNER");
  const ownerPage = owner;
  const { id: projectId } = await send(ownerPage, "post", "/api/projects", { name: `Smoke ${runId}` }, 201);
  created.push({ id: projectId, archived: false });
  saveLedger();
  const base = `/api/projects/${projectId}`;
  const flowId = randomUUID(), startId = randomUUID(), outcomeId = randomUUID();
  let draftId = "";

  await test.step("save, reload and conflict", async () => {
    const boot = await read(ownerPage, `${base}/bootstrap`);
    draftId = boot.draft.id;
    const revision = boot.draft.documentRevision;
    await send(ownerPage, "post", `${base}/drafts/${draftId}/changes`, { moves: [], commands: [ // review-support.ts readyCandidate
      { command: "CREATE_FLOW", payload: { title: "Smoke checkout", purpose: "Smoke", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
      { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Begin", description: "", actorLabel: "" }, proposedIds: [startId] },
      { command: "ADD_NODE", payload: { flowId, kind: "OUTCOME", label: "Done", description: "", actorLabel: "" }, proposedIds: [outcomeId] },
      { command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: outcomeId, condition: "" }, proposedIds: [randomUUID()] },
    ].map((command, index) => ({ commandSchemaVersion: 1, expectedDocumentRevision: revision + index, ...command })) }, 200);
    await ownerPage.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(ownerPage, startId)).toBeVisible();
    await ownerPage.reload();
    await expect(nodeAt(ownerPage, outcomeId)).toBeVisible();
    const stale = await send(ownerPage, "post", `${base}/drafts/${draftId}/commands`, { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: revision, payload: { title: "Stale", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, 409);
    expect(stale.error.code).toBe("STALE_DOCUMENT_REVISION"); // draft-api.spec.ts
  });

  await test.step("approve and export an exact candidate, newer work stays", async () => {
    const flow = (await read(ownerPage, `${base}/drafts/${draftId}`)).document.flows[flowId];
    await send(ownerPage, "post", `${base}/drafts/${draftId}/commands`, { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: flow.version, payload: { flowId } }, 200);
    let status = await read(ownerPage, `${base}/status`);
    await send(ownerPage, "patch", `${base}/approval-policy`, { designatedApproverId: status.viewerId, expectedApprovalPolicyVersion: status.approvalPolicyVersion }, 200);
    status = await read(ownerPage, `${base}/status`);
    const review = await send(ownerPage, "post", `${base}/drafts/${draftId}/reviews`, { expectedDocumentRevision: status.documentRevision, expectedLayoutRevision: status.layoutRevision, expectedParentSnapshotId: status.approvedSnapshotId, expectedApprovalPolicyVersion: status.approvalPolicyVersion }, 201);
    const decision = await send(ownerPage, "post", `${base}/reviews/${review.reviewId}/decision`, { decision: "APPROVE", expectedReviewVersion: review.reviewVersion, expectedReviewHash: review.reviewHash }, 200);
    expect(decision.state).toBe("APPROVED");
    const markdown = await ownerPage.request.get(`${base}/snapshots/${decision.approvedSnapshotId}/export?format=markdown`); // reviews-api.spec.ts
    expect(markdown.status()).toBe(200);
    expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(await markdown.text()).toMatch(/^# Approved scope\n[\s\S]*Smoke checkout/);
    const before = await read(ownerPage, `${base}/status`);
    await send(ownerPage, "post", `${base}/drafts/${draftId}/commands`, { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: before.documentRevision, payload: { flowId, kind: "ACTION", label: `After approval ${runId}`, description: "", actorLabel: "" } }, 200);
    const after = await read(ownerPage, `${base}/status`);
    expect(after).toMatchObject({ currentDraftId: draftId, approvedSnapshotId: decision.approvedSnapshotId, documentRevision: before.documentRevision + 1 });
  });

  const editor = await signIn(browser, "EDITOR");
  const viewer = await signIn(browser, "VIEWER");

  await test.step("invite by copied link, live presence and updates", async () => {
    for (const [page, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) {
      const invitation = await send(ownerPage, "post", `${base}/invitations`, { verifiedEmail: process.env[`SMOKE_${role}_EMAIL`], role }, 201); // invitation-api.spec.ts
      await page.goto(new URL(invitation.url, origin).pathname); // auto-accepts on mount, then opens the project
      await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}$`));
    }
    expect((await read(editor, `${base}/status`)).role).toBe("EDITOR");
    const token = await editor.request.post(`${base}/realtime-token`, { headers: { Origin: origin } }); // realtime-token-api.spec.ts
    expect(token.status()).toBe(200);
    await ownerPage.goto(`/app/projects/${projectId}`);
    await expect(ownerPage.getByText(/other (person|people) here/)).toBeVisible(); // presence travels only over private Realtime
    const status = await read(ownerPage, `${base}/status`);
    const liveId = randomUUID();
    await send(ownerPage, "post", `${base}/drafts/${draftId}/changes`, { moves: [], commands: [{ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: status.documentRevision, payload: { flowId, kind: "ACTION", label: `Live ${runId}`, description: "", actorLabel: "" }, proposedIds: [liveId] }] }, 200);
    await expect(nodeAt(editor, liveId)).toBeVisible(); // collaboration-live.spec.ts: hint or the 10 s status poll
  });

  await test.step("viewer is read-only", async () => {
    const status = await read(viewer, `${base}/status`);
    const denied = await send(viewer, "post", `${base}/drafts/${draftId}/commands`, { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: status.documentRevision, payload: { title: "Viewer", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, 403);
    expect(denied.error.code).toBe("FORBIDDEN");
  });

  await test.step("saves continue while Realtime is down", async () => {
    const cut = await editor.context().newPage();
    await cut.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => ws.close({ code: 1011, reason: "smoke outage" })); // collaboration-fixtures.ts interceptRealtime
    await cut.goto(`/app/projects/${projectId}`);
    await expect(cut.getByRole("status").filter({ hasText: "Live updates delayed" })).toBeVisible({ timeout: 45_000 });
    const status = await read(cut, `${base}/status`);
    const degradedId = randomUUID();
    // ponytail: saves through the degraded page's own session over HTTP; the Studio Save button path is covered by collaboration-live.spec.ts.
    await send(cut, "post", `${base}/drafts/${draftId}/changes`, { moves: [], commands: [{ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: status.documentRevision, payload: { flowId, kind: "ACTION", label: `Degraded ${runId}`, description: "", actorLabel: "" }, proposedIds: [degradedId] }] }, 200);
    await cut.reload();
    await expect(nodeAt(cut, degradedId)).toBeVisible();
    await cut.close();
  });

  await test.step("removed member loses access", async () => {
    const { members } = await read(ownerPage, `${base}/members`);
    const member = members.find((entry: { role: string }) => entry.role === "VIEWER");
    await send(ownerPage, "delete", `${base}/members/${member.profileId}`, { expectedMemberVersion: member.version }, 200);
    expect((await viewer.request.get(`${base}/bootstrap`)).status()).toBe(404);
    expect((await viewer.request.post(`${base}/realtime-token`, { headers: { Origin: origin } })).status()).toBe(404);
  });

  await test.step("AI Generate and Improve with reviewed Apply", async () => {
    // Not test.skip: that would mark the whole qualified journey skipped. Record the omission and leave the step.
    if (process.env.SMOKE_AI !== "1") return void test.info().annotations.push({ type: "AI", description: "not run: SMOKE_AI is not 1, no paid model calls" });
    for (const [taskType, selection] of [["PROPOSE_FLOW", null], ["REFINE_FLOW_SELECTION", { flowId, nodeIds: [startId] }]] as const) {
      const status = await read(ownerPage, `${base}/status`);
      const started = await send(ownerPage, "post", `${base}/ai-runs`, { taskType, prompt: `Smoke ${runId}: outline a short sign-up flow`, draftId, expectedDocumentRevision: status.documentRevision, expectedParentSnapshotId: status.approvedSnapshotId, context: { selection, sources: [] } }, 202); // ai-api.spec.ts
      const run = await waitForRun(ownerPage, projectId, started.runId);
      test.info().annotations.push({ type: taskType, description: `${run.state} ${run.result?.kind ?? run.failureCode ?? ""}` });
      expect(run.state).toBe("SUCCEEDED");
      if (run.result?.kind !== "proposal") continue; // a valid clarification qualifies the run, not Apply
      expect(run.applicability).toBe("APPLICABLE");
      // proposal-review.tsx apply body
      await send(ownerPage, "post", `${base}/ai-runs/${started.runId}/apply`, { draftId: run.draftId, expectedDocumentRevision: run.documentRevision, expectedParentSnapshotId: run.parentSnapshotId, resultHash: run.resultHash, selectedOperationIds: run.result.operations.map((operation) => operation.id) }, 200);
    }
  });
});
