import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, headerSave, openDatabase, saveStudio, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Task 14b: every draft change is local until Save, the 10-second autosave or a save-first action sends one batch.
type Batch = { commands: { command: string; proposedIds: string[] }[]; moves: { flowId: string; items: { nodeId: string }[] }[] };
const status = (page: Page) => page.locator(".studio-status");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const edgeAt = (page: Page, edgeId: string) => page.locator(`.react-flow__edge[data-id="${edgeId}"]`);
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const warnsBeforeUnload = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** Start, Pay and Ship steps with a Start → Pay connection, created through the real command route. */
async function seed(page: Page, projectId: string) {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds[0]!;
  };
  const flowId = await send({ command: "CREATE_FLOW", payload: { title: "Outbox", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const node = (kind: string, label: string) => send({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" } });
  const startId = await node("START", "Start");
  const payId = await node("ACTION", "Pay");
  const shipId = await node("ACTION", "Ship");
  const edgeId = await send({ command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" } });
  return { flowId, startId, payId, shipId, edgeId };
}

/** A client point halfway along a connection's drawn path. */
async function edgePoint(page: Page, edgeId: string) {
  return edgeAt(page, edgeId).locator("path.react-flow__edge-path").evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: at.x, y: at.y };
  });
}

/** Clicks halfway along a connection, which selects it. */
async function clickEdge(page: Page, edgeId: string) {
  const point = await edgePoint(page, edgeId);
  await page.mouse.click(point.x, point.y);
}

/** Connects two steps by dragging from one's bottom handle to the other's top handle. Each side is two stacked
 * elements (source- and target-typed, Task 13 fix round 1); `.first()` just picks one of the pair. */
async function connect(page: Page, fromId: string, toId: string) {
  await nodeAt(page, fromId).locator('.react-flow__handle[data-handleid="bottom"]').first().dragTo(nodeAt(page, toId).locator('.react-flow__handle[data-handleid="top"]').first());
}

test.describe("Save covers every change (real draft)", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;
  let ids: Awaited<ReturnType<typeof seed>>;
  let saves: Request[];

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Outbox Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Outbox project");
    ids = await seed(page, projectId);
    saves = [];
    page.on("request", (request) => { if (request.method() === "POST" && /\/(commands|positions|changes)$/.test(request.url())) saves.push(request); });
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, ids.payId)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("connecting two steps enables Save and the leave guard; nothing is sent until Save", async ({ page }) => {
    await expect(headerSave(page)).toBeDisabled();
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("2 connections");
    await expect(status(page)).toContainText("Unsaved changes");
    await expect(headerSave(page)).toBeEnabled();
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.waitForTimeout(500);
    expect(saves).toHaveLength(0);
    expect(Object.keys((await draftOf(page, projectId)).document.edges)).toHaveLength(1);

    await saveStudio(page);
    expect(saves).toHaveLength(1);
    expect((saves[0]!.postDataJSON() as Batch).commands.map((command) => command.command)).toEqual(["ADD_EDGE"]);
    const saved = await draftOf(page, projectId);
    expect(Object.values(saved.document.edges).some((edge) => edge.fromId === ids.payId && edge.toId === ids.shipId)).toBe(true);
    await expect(headerSave(page)).toBeDisabled();
    expect(await warnsBeforeUnload(page)).toBe(false);
  });

  test("Delete on a selected connection removes it locally without a dialog, Undo and Redo work on it, and Save persists it", async ({ page }) => {
    await clickEdge(page, ids.edgeId);
    await expect(edgeAt(page, ids.edgeId)).toHaveClass(/selected/);
    await page.keyboard.press("Delete");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(edgeAt(page, ids.edgeId)).toHaveCount(0);
    await expect(status(page)).toContainText("0 connections");
    await status(page).getByRole("button", { name: "Undo" }).click();
    await expect(edgeAt(page, ids.edgeId)).toHaveCount(1);
    await status(page).getByRole("button", { name: "Redo" }).click();
    await expect(edgeAt(page, ids.edgeId)).toHaveCount(0);
    expect(saves).toHaveLength(0);
    expect((await draftOf(page, projectId)).document.edges[ids.edgeId]).toBeTruthy();

    await saveStudio(page);
    expect((saves[0]!.postDataJSON() as Batch).commands.map((command) => command.command)).toEqual(["DELETE_EDGE"]);
    const saved = await draftOf(page, projectId);
    expect(saved.document.edges[ids.edgeId]).toBeUndefined();
    expect(saved.document.retiredEntityIds).toContain(ids.edgeId);
    await expect(status(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  });

  test("one Save sends one request with every kind of change: a new step, a connection, a rename, a label, a deletion and a move", async ({ page }) => {
    await page.locator(".shape-panel").getByRole("button", { name: "Decision" }).click();
    const created = page.locator(".react-flow__node").filter({ has: page.locator('.step-node[data-kind="DECISION"]') });
    const createdId = (await created.getAttribute("data-id"))!;
    await page.keyboard.type("Paid?");
    await page.keyboard.press("Enter");
    await page.locator(".studio-toolbar").getByRole("button", { name: "Connect" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect steps" });
    await dialog.getByLabel("From").selectOption({ label: "Pay" });
    await dialog.getByLabel("To").selectOption({ label: "Paid?" });
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(dialog).toBeHidden();
    await nodeAt(page, ids.shipId).locator(".step-label").dblclick();
    await nodeAt(page, ids.shipId).getByRole("textbox", { name: "Step name" }).fill("Ship fast");
    await page.keyboard.press("Enter");
    const labelPoint = await edgePoint(page, ids.edgeId);
    await page.mouse.dblclick(labelPoint.x, labelPoint.y);
    await page.getByRole("textbox", { name: "Connection label" }).fill("Always");
    await page.keyboard.press("Enter");
    const box = (await nodeAt(page, ids.startId).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    // Deleting a step still asks first.
    await nodeAt(page, ids.shipId).click();
    await page.keyboard.press("Delete");
    await page.getByRole("dialog", { name: "Delete step" }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(status(page)).toContainText("Unsaved changes");
    expect(saves).toHaveLength(0);
    const before = await draftOf(page, projectId);

    await saveStudio(page);
    expect(saves).toHaveLength(1);
    const body = saves[0]!.postDataJSON() as Batch;
    expect(body.commands.map((command) => command.command)).toEqual(["ADD_NODE", "UPDATE_NODE", "ADD_EDGE", "UPDATE_NODE", "UPDATE_EDGE", "DELETE_NODES"]);
    expect(body.commands[0]!.proposedIds).toEqual([createdId]);
    expect(body.moves.flatMap((group) => group.items.map((item) => item.nodeId)).sort()).toEqual([createdId, ids.startId].sort());
    const saved = await draftOf(page, projectId);
    expect(saved.documentRevision).toBe(before.documentRevision + 6);
    expect(saved.document.nodes[createdId]!.label).toBe("Paid?");
    expect(saved.document.nodes[ids.shipId]).toBeUndefined();
    expect(saved.document.edges[ids.edgeId]!.condition).toBe("Always");
    expect(Object.values(saved.document.edges).some((edge) => edge.fromId === ids.payId && edge.toId === createdId)).toBe(true);
    expect(saved.layout.positions[ids.startId]!.version).toBe(2);
  });

  test("autosave sends a connection and a rename together 10 seconds after they start waiting", async ({ page }) => {
    await page.clock.install();
    await page.reload();
    await expect(nodeAt(page, ids.payId)).toBeVisible();
    await connect(page, ids.payId, ids.shipId);
    await nodeAt(page, ids.payId).locator(".step-label").dblclick();
    await nodeAt(page, ids.payId).getByRole("textbox", { name: "Step name" }).fill("Pay now");
    await page.keyboard.press("Enter");
    await page.clock.fastForward(8_000);
    await page.waitForTimeout(300);
    expect(saves).toHaveLength(0);
    await page.clock.fastForward(2_500);
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(1);
    expect((saves[0]!.postDataJSON() as Batch).commands.map((command) => command.command)).toEqual(["ADD_EDGE", "UPDATE_NODE"]);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Pay now");
  });

  test("switching projects guards edits made during the save's final read", async ({ page }) => {
    await createProjectViaApi(page, "Other outbox project");
    await page.reload();
    await expect(nodeAt(page, ids.payId)).toBeVisible();
    // Both queued canvas edits and unapplied inspector text can arrive after the batch was acknowledged.
    for (const mode of ["queued", "buffered"] as const) {
      await nodeAt(page, ids.payId).locator(".step-label").dblclick();
      await nodeAt(page, ids.payId).getByRole("textbox", { name: "Step name" }).fill(`Pay ${mode}`);
      await page.keyboard.press("Enter");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reading = false;
      const readUrl = `**/api/projects/${projectId}/drafts/*`;
      await page.route(readUrl, async (route) => { reading = true; await held; await route.continue(); });
      try {
        await page.locator("#projects-nav").getByRole("button", { name: "Other outbox project", exact: true }).click();
        await expect.poll(() => reading).toBe(true);
        if (mode === "queued") {
          await nodeAt(page, ids.shipId).locator(".step-label").dblclick();
          await nodeAt(page, ids.shipId).getByRole("textbox", { name: "Step name" }).fill("Ship after read");
          await page.keyboard.press("Enter");
        } else {
          await nodeAt(page, ids.shipId).click();
          await page.getByRole("button", { name: "Inspect", exact: true }).click();
          await page.locator("#right-panel").getByLabel("Description", { exact: true }).fill("Text typed during read");
        }
        release();
        const guard = page.getByRole("dialog", { name: "Unsaved changes in Outbox project" });
        await expect(guard).toBeVisible();
        await guard.getByRole("button", { name: "Stay" }).click();
        await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}$`));
      } finally { release(); await page.unroute(readUrl); }
      if (mode === "queued") await saveStudio(page);
      else await expect(page.locator("#right-panel").getByLabel("Description", { exact: true })).toHaveValue("Text typed during read");
    }
  });
});
