import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { STEP_SIZE } from "../../src/features/drafts/contracts/draft-layout.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const panel = (page: Page) => page.locator(".shape-panel");
const canvas = (page: Page) => page.locator(".canvas");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** One flow with a single Start step, created through the real command route (no dialog needed for these tests). */
async function seedFlow(page: Page, projectId: string): Promise<{ draftId: string; flowId: string; startId: string }> {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds;
  };
  const [flowId] = await send({ command: "CREATE_FLOW", payload: { title: "Shapes", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const [startId] = await send({ command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" } });
  return { draftId, flowId: flowId!, startId: startId! };
}

/** Converts a viewport (client) point to the flow position React Flow's own `screenToFlowPosition` would report,
 * reading the same root rect and `.react-flow__viewport` transform the library itself uses. */
async function flowPoint(page: Page, clientX: number, clientY: number) {
  return page.evaluate(([px, py]) => {
    const root = document.querySelector(".react-flow") as HTMLElement;
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(viewport.style.transform)!;
    const [tx, ty, scale] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const rect = root.getBoundingClientRect();
    return { x: (px - rect.left - tx) / scale, y: (py - rect.top - ty) / scale };
  }, [clientX, clientY] as const);
}

/** A synthetic HTML5 drag-and-drop drop of one shape-panel payload onto the canvas at a client point. */
async function dropShape(page: Page, kind: string, clientX: number, clientY: number) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.evaluate(([dt, payload]) => (dt as DataTransfer).setData("application/x-scoperoom-shape", payload), [dataTransfer, JSON.stringify({ kind, width: 1, height: 1 })] as const);
  await canvas(page).dispatchEvent("dragover", { dataTransfer, clientX, clientY, bubbles: true, cancelable: true });
  await canvas(page).dispatchEvent("drop", { dataTransfer, clientX, clientY, bubbles: true, cancelable: true });
}

test.describe("Shape panel (real draft)", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Shapes Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Shapes project");
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("dropping a shape adds one step at the rounded drop point, with one document change and one position save", async ({ page }) => {
    const seeded = await seedFlow(page, projectId);
    const moves: Request[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/positions")) moves.push(request); });
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, seeded.startId)).toBeVisible();

    for (const kind of ["Start", "Step", "Decision", "Data store", "End (Outcome)"] as const) {
      await expect(panel(page).getByRole("button", { name: kind })).toBeVisible();
    }

    const before = await draftOf(page, projectId);
    const box = (await canvas(page).boundingBox())!;
    const clientX = box.x + box.width * 0.7, clientY = box.y + box.height * 0.6;
    const point = await flowPoint(page, clientX, clientY);
    const size = STEP_SIZE.DATA_STORE;
    const expected = { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) };

    await dropShape(page, "DATA_STORE", clientX, clientY);

    // Creation and its follow-up move are two sequential requests; wait for the move to actually land before reading.
    await expect.poll(() => moves.length).toBe(1);
    expect((await moves[0]!.response())?.status()).toBe(200);
    const after = await draftOf(page, projectId);
    expect(after.documentRevision).toBe(before.documentRevision + 1);
    const createdId = Object.keys(after.document.nodes).find((id) => !before.document.nodes[id]);
    expect(createdId).toBeTruthy();
    const created = after.document.nodes[createdId!]!;
    expect(created.kind).toBe("DATA_STORE");
    expect(created.label).toBe("Data store");
    expect(after.layout.positions[createdId!]).toEqual({ x: expected.x, y: expected.y, version: 2 });
    await expect(nodeAt(page, createdId!)).toBeVisible();
  });

  test("clicking End adds an OUTCOME step", async ({ page }) => {
    await seedFlow(page, projectId);
    await page.goto(`/app/projects/${projectId}`);
    const before = await draftOf(page, projectId);
    await panel(page).getByRole("button", { name: "End (Outcome)" }).click();
    await expect.poll(async () => Object.keys((await draftOf(page, projectId)).document.nodes).length).toBe(Object.keys(before.document.nodes).length + 1);
    const after = await draftOf(page, projectId);
    const createdId = Object.keys(after.document.nodes).find((id) => !before.document.nodes[id])!;
    expect(after.document.nodes[createdId]!.kind).toBe("OUTCOME");
    await expect(nodeAt(page, createdId)).toHaveClass(/selected/);
  });
});

test.describe("Shape panel (read-only, mocked project)", () => {
  const projectId = "c2222222-2222-4222-8222-222222222222";
  const flowId = "d2222222-2222-4222-8222-222222222222";
  const startId = "e3333333-3333-4333-8333-333333333333";

  test("a reader sees no shape panel", async ({ page }) => {
    const admin = adminClient();
    const database = await openDatabase();
    const users: string[] = [];
    await signIn(page, admin, users, "Shapes Reader");
    const view = emptyDraftView();
    const draft: DraftView = {
      ...view,
      document: {
        ...view.document,
        flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: "Intake", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null } },
        nodes: { [startId]: { id: startId, flowId, version: 1, behaviourVersion: 1, kind: "START", label: "Receive form", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] } },
        edges: {},
      },
      layout: { schemaVersion: 1, positions: { [startId]: { x: 0, y: 0, version: 1 } }, directions: { [flowId]: "TB" } },
    };
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [], truncated: false }, shared: { items: [{ id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" }], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerId: projectId }, draft } }));
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, startId)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });
});
