import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

type Draft = {
  id: string;
  status: string;
  documentRevision: number;
  layoutRevision: number;
  document: { flows: Record<string, { title: string }>; nodes: Record<string, { description: string }> };
  layout: { directions: Record<string, string> };
};

const createFlow = (expectedDocumentRevision: number, title = "Checkout") => ({
  commandSchemaVersion: 1,
  command: "CREATE_FLOW",
  expectedDocumentRevision,
  payload: { title, purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" },
});

test("draft routes require identity, same origin and a key, and never cache", async ({ request }) => {
  const [projectId, draftId] = [randomUUID(), randomUUID()];
  const read = await request.get(`/api/projects/${projectId}/drafts/${draftId}`);
  expect(read.status()).toBe(401);
  expect(read.headers()["cache-control"]).toContain("no-store");
  const url = `/api/projects/${projectId}/drafts/${draftId}/commands`;
  expect((await request.post(url, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: createFlow(1) })).status()).toBe(401);
  for (const origin of [undefined, "https://evil.example"]) {
    const refused = await request.post(url, { headers: { ...(origin ? { Origin: origin } : {}), "Idempotency-Key": randomUUID() }, data: createFlow(1) });
    expect(refused.status()).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
  }
});

test("an owner saves a command once, reads the coherent draft, and another account cannot see it", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = adminClient();
  const database = await openDatabase();
  const users: string[] = [];
  const other = await browser.newContext();
  try {
    const { authUserId } = await signIn(page, admin, users, "Draft API Owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Draft API project");
    const bootstrap = await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } };
    const base = `/api/projects/${projectId}/drafts/${bootstrap.draft.id}`;
    const post = (data: unknown, key = randomUUID()) => page.request.post(`${base}/commands`, { headers: { Origin: appUrl, "Idempotency-Key": key }, data });

    const keyless = await page.request.post(`${base}/commands`, { headers: { Origin: appUrl }, data: createFlow(1) });
    expect(keyless.status()).toBe(400);
    const oversized = await post({ ...createFlow(1), payload: { ...createFlow(1).payload, purpose: "x".repeat(70_000) } });
    expect(oversized.status()).toBe(400);
    const forged = await post({ ...createFlow(1), key: randomUUID() });
    expect(forged.status()).toBe(400);
    expect((await forged.json() as { error: { code: string } }).error.code).toBe("INVALID_INPUT");

    const replacement = await post({ ...createFlow(1), documentJson: {} });
    expect(replacement.status()).toBe(400);
    expect((await replacement.json() as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    const key = randomUUID();
    const saved = await post(createFlow(1), key);
    expect(saved.status()).toBe(200);
    const result = await saved.json() as { createdIds: string[]; documentRevision: number; replayed: boolean };
    expect(result).toMatchObject({ documentRevision: 2, replayed: false });
    expect(await (await post(createFlow(1), key)).json()).toMatchObject({ createdIds: result.createdIds, replayed: true });
    const stale = await post(createFlow(1, "Late"));
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_DOCUMENT_REVISION", details: { documentRevision: 2 } } });

    // 4,000 Vietnamese code points are about 12 KiB of UTF-8: inside the 64 KiB command body limit.
    const longText = "ệ".repeat(4_000);
    const step = await post({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId: result.createdIds[0], kind: "ACTION", label: "Long", description: longText, actorLabel: "" } });
    expect(step.status()).toBe(200);
    const stepId = (await step.json() as { createdIds: string[] }).createdIds[0]!;

    const draft = await (await page.request.get(base)).json() as Draft;
    expect(draft).toMatchObject({ id: bootstrap.draft.id, status: "EDITABLE", documentRevision: 3, layoutRevision: 3 });
    expect(draft.document.nodes[stepId]!.description).toBe(longText);
    expect(draft.document.flows[result.createdIds[0]!]!.title).toBe("Checkout");
    expect(draft.layout.directions[result.createdIds[0]!]).toBe("TB");

    const otherPage = await other.newPage();
    await signIn(otherPage, admin, users, "Draft API Outsider");
    expect((await otherPage.request.get(base)).status()).toBe(404);
    const outsider = await otherPage.request.post(`${base}/commands`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: createFlow(3) });
    expect(outsider.status()).toBe(404);
    await otherPage.close();
  } finally {
    await other.close();
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});

test("position routes: a move needs a key and same origin; a preview needs same origin, takes no key and saves nothing", async ({ page }) => {
  test.setTimeout(60_000);
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  try {
    const { authUserId } = await signIn(page, admin, users, "Position API Owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Position API project");
    const draftId = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft.id;
    const base = `/api/projects/${projectId}/drafts/${draftId}`;
    const created = await page.request.post(`${base}/commands`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: createFlow(1) });
    const flowId = (await created.json() as { createdIds: string[] }).createdIds[0];
    const added = await page.request.post(`${base}/commands`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" } } });
    const nodeId = (await added.json() as { createdIds: string[] }).createdIds[0];
    const move = { mode: "MOVE_NODES", flowId, items: [{ nodeId, expectedPositionVersion: 1, x: 10, y: 20 }] };
    expect((await page.request.post(`${base}/positions`, { headers: { Origin: appUrl }, data: move })).status()).toBe(400);
    const moved = await page.request.post(`${base}/positions`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: move });
    expect(moved.status()).toBe(200);
    expect(await moved.json()).toMatchObject({ layoutRevision: 4, positions: { [nodeId!]: { x: 10, y: 20, version: 2 } }, replayed: false });
    const request = { flowId, expectedDocumentRevision: 3, expectedLayoutRevision: 4, direction: "TB" };
    expect((await page.request.post(`${base}/arrangement-preview`, { data: request })).status()).toBe(403);
    const preview = await page.request.post(`${base}/arrangement-preview`, { headers: { Origin: appUrl }, data: request });
    expect(preview.status()).toBe(200);
    expect(await preview.json()).toMatchObject({ flowId, direction: "TB", layoutRevision: 4, arrangementHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const draft = await (await page.request.get(base)).json() as { layoutRevision: number };
    expect(draft.layoutRevision).toBe(4);
  } finally {
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});

test("the batch save route needs a key and same origin, then saves every change with the proposed ids in one request", async ({ page }) => {
  test.setTimeout(60_000);
  const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
  try {
    const { authUserId } = await signIn(page, admin, users, "Changes API Owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Changes API project");
    const draftId = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft.id;
    const url = `/api/projects/${projectId}/drafts/${draftId}/changes`;
    const [flowId, nodeId] = [randomUUID(), randomUUID()];
    const batch = {
      commands: [
        { ...createFlow(1), proposedIds: [flowId] },
        { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [nodeId] },
      ],
      moves: [{ flowId, items: [{ nodeId, expectedPositionVersion: 1, x: 40, y: 80 }] }],
    };
    expect((await page.request.post(url, { headers: { Origin: appUrl }, data: batch })).status()).toBe(400);
    for (const origin of [undefined, "https://evil.example"]) {
      const refused = await page.request.post(url, { headers: { ...(origin ? { Origin: origin } : {}), "Idempotency-Key": randomUUID() }, data: batch });
      expect(refused.status()).toBe(403);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
    }
    const saved = await page.request.post(url, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: batch });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({ draftId, documentRevision: 3, layoutRevision: 2, createdIds: [flowId, nodeId], positions: { [nodeId]: { x: 40, y: 80, version: 2 } }, replayed: false });
    const draft = await (await page.request.get(`/api/projects/${projectId}/drafts/${draftId}`)).json() as Draft & { layout: { positions: Record<string, unknown> } };
    expect(draft.document.flows[flowId]!.title).toBe("Checkout");
    expect(draft.layout.positions[nodeId]).toEqual({ x: 40, y: 80, version: 2 });
  } finally {
    await cleanupUsers(database, admin, users, page);
    await database.end();
  }
});
