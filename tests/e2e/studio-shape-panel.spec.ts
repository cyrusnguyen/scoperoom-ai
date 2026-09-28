import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { STEP_SIZE } from "../../src/features/drafts/contracts/draft-layout.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, headerSave, openDatabase, saveStudio, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const panel = (page: Page) => page.locator(".shape-panel");
const canvas = (page: Page) => page.locator(".canvas");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
type Batch = { commands: { command: string; proposedIds: string[]; payload: Record<string, unknown> }[]; moves: { flowId: string; items: { nodeId: string; expectedPositionVersion: number; x: number; y: number }[] }[] };
const WRITES = /\/(commands|positions|changes)$/;
/** Every write the Studio sends (Task 14b: only batch saves). */
function recordWrites(page: Page) {
  const writes: Request[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && WRITES.test(request.url())) writes.push(request); });
  return writes;
}

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** One flow with a single Start step, created through the real command route (no dialog needed for these tests). */
async function seedFlow(page: Page, projectId: string, title = "Shapes"): Promise<{ draftId: string; flowId: string; startId: string }> {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds;
  };
  const [flowId] = await send({ command: "CREATE_FLOW", payload: { title, purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
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

  test("a dropped shape shows at the rounded drop point at once, with no request; Save sends its creation and placement in one batch", async ({ page }) => {
    const seeded = await seedFlow(page, projectId);
    const writes = recordWrites(page);
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
    // Hold every write: the step must show at its drop point without one.
    await page.route(WRITES, () => {});

    await dropShape(page, "DATA_STORE", clientX, clientY);

    const created = page.locator(".react-flow__node").filter({ hasText: "Data store" });
    await expect(created).toHaveAttribute("style", new RegExp(`translate\\(${expected.x}px, ${expected.y}px\\)`));
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    expect(writes).toHaveLength(0);
    const createdId = (await created.getAttribute("data-id"))!;
    expect(await draftOf(page, projectId)).toEqual(before);

    await page.unroute(WRITES);
    await saveStudio(page);
    expect(writes).toHaveLength(1);
    const body = writes[0]!.postDataJSON() as Batch;
    expect(body.commands.map((command) => [command.command, command.proposedIds])).toEqual([["ADD_NODE", [createdId]]]);
    expect(body.moves).toEqual([{ flowId: seeded.flowId, items: [{ nodeId: createdId, expectedPositionVersion: 1, ...expected }] }]);
    const after = await draftOf(page, projectId);
    expect(after.documentRevision).toBe(before.documentRevision + 1);
    expect(after.document.nodes[createdId]).toMatchObject({ kind: "DATA_STORE", label: "Data store" });
    expect(after.layout.positions[createdId]).toEqual({ x: expected.x, y: expected.y, version: 2 });
  });

  test("clicking End adds an OUTCOME step, selected at once", async ({ page }) => {
    await seedFlow(page, projectId);
    await page.goto(`/app/projects/${projectId}`);
    const before = await draftOf(page, projectId);
    await panel(page).getByRole("button", { name: "End (Outcome)" }).click();
    const created = page.locator(".react-flow__node").filter({ has: page.locator('.step-node[data-kind="OUTCOME"]') });
    await expect(created).toHaveClass(/selected/);
    const createdId = (await created.getAttribute("data-id"))!;
    await page.keyboard.press("Escape"); // leave the name as it is
    await saveStudio(page);
    const after = await draftOf(page, projectId);
    expect(Object.keys(after.document.nodes)).toHaveLength(Object.keys(before.document.nodes).length + 1);
    expect(after.document.nodes[createdId]!.kind).toBe("OUTCOME");
  });

  test("a step dropped in one flow is saved there when a flow switch saves it first", async ({ page }) => {
    const flowA = await seedFlow(page, projectId, "Flow A");
    const flowB = await seedFlow(page, projectId, "Flow B");
    await page.goto(`/app/projects/${projectId}`);
    const flowsDialog = page.getByRole("dialog", { name: "Flows" });
    // Land on Flow A regardless of which flow bootstrap opened by default.
    await page.locator(".flow-switch").click();
    await flowsDialog.locator(".item-row").filter({ hasText: "Flow A" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Flow A");
    await expect(nodeAt(page, flowA.startId)).toBeVisible();

    const box = (await canvas(page).boundingBox())!;
    const centre = await flowPoint(page, box.x + box.width / 2, box.y + box.height / 2);
    const size = STEP_SIZE.OUTCOME;
    const expected = { x: Math.round(centre.x - size.width / 2), y: Math.round(centre.y - size.height / 2) };
    const writes = recordWrites(page);

    await panel(page).getByRole("button", { name: "End (Outcome)" }).click();
    await page.keyboard.press("Escape");
    expect(writes).toHaveLength(0);
    await page.locator(".flow-switch").click();
    await flowsDialog.locator(".item-row").filter({ hasText: "Flow B" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Flow B");
    expect(writes).toHaveLength(1);
    expect((writes[0]!.postDataJSON() as Batch).moves.map((group) => group.flowId)).toEqual([flowA.flowId]);

    // The created step belongs to Flow A: its saved position (and the move that placed it) must say so, never Flow B.
    const after = await draftOf(page, projectId);
    const createdId = Object.keys(after.document.nodes).find((id) => after.document.nodes[id]!.flowId === flowA.flowId && id !== flowA.startId)!;
    expect(createdId).toBeTruthy();
    expect(after.document.nodes[createdId]!.kind).toBe("OUTCOME");
    expect(after.document.nodes[createdId]!.flowId).not.toBe(flowB.flowId);
    expect(after.layout.positions[createdId]).toEqual({ x: expected.x, y: expected.y, version: 2 });
    await expect(headerSave(page)).toBeDisabled();
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
      layout: { schemaVersion: 1, positions: { [startId]: { x: 0, y: 0, version: 1 } }, directions: { [flowId]: "TB" }, edgeSides: {} },
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
