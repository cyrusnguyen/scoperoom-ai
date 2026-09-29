import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, headerSave, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Task 9: the floating control bar (zoom, undo, redo) and the canvas keyboard shortcuts.
const status = (page: Page) => page.locator(".studio-status");
const bar = (page: Page) => page.getByRole("group", { name: "Canvas controls" });
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const hasScale = (page: Page) => page.locator(".react-flow__viewport").evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
/** The viewport's scale once React Flow's 200 ms zoom animation has settled. */
async function scale(page: Page) {
  let last = await hasScale(page);
  for (let index = 0; index < 20; index += 1) {
    await page.waitForTimeout(100);
    const next = await hasScale(page);
    if (next === last) return next;
    last = next;
  }
  return last;
}

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
  const flowId = await send({ command: "CREATE_FLOW", payload: { title: "Controls", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const node = (kind: string, label: string) => send({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" } });
  const startId = await node("START", "Start");
  const payId = await node("ACTION", "Pay");
  const shipId = await node("ACTION", "Ship");
  await send({ command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" } });
  return { flowId, startId, payId, shipId };
}

/** Connects two steps by dragging from one's bottom handle to the other's top handle: one unsaved change. */
async function connect(page: Page, fromId: string, toId: string) {
  await nodeAt(page, fromId).locator('.react-flow__handle[data-handleid="bottom"]').first().dragTo(nodeAt(page, toId).locator('.react-flow__handle[data-handleid="top"]').first());
}

/** Dispatches a key press on the window and reports whether a shortcut acted (called preventDefault). */
const acted = (page: Page, init: { key: string; ctrlKey?: boolean; metaKey?: boolean }) => page.evaluate((keyInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...keyInit });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}, init);

test.describe("Canvas control bar and shortcuts (real draft)", () => {
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
    const { authUserId } = await signIn(page, admin, users, "Controls Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Controls project");
    ids = await seed(page, projectId);
    saves = [];
    await page.setViewportSize({ width: 1600, height: 900 }); // wide enough that opening the inspector keeps the Canvas view
    page.on("request", (request) => { if (request.method() === "POST" && /\/(commands|positions|changes)$/.test(request.url())) saves.push(request); });
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, ids.payId)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("the bar replaces React Flow's controls; zoom buttons and + / - change the viewport, double-clicking the pane does not", async ({ page }) => {
    await expect(page.locator(".react-flow__controls")).toHaveCount(0);
    await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
    await expect(bar(page).getByRole("button")).toHaveCount(5);
    const initial = await scale(page);
    await bar(page).getByRole("button", { name: "Zoom In", exact: true }).click();
    const zoomedIn = await scale(page);
    expect(zoomedIn).toBeGreaterThan(initial);
    await bar(page).getByRole("button", { name: "Zoom Out", exact: true }).click();
    await bar(page).getByRole("button", { name: "Zoom Out", exact: true }).click();
    const zoomedOut = await scale(page);
    expect(zoomedOut).toBeLessThan(initial);
    await bar(page).getByRole("button", { name: "Fit View", exact: true }).click();
    expect(await scale(page)).toBeCloseTo(initial, 1);

    await page.keyboard.press("+");
    const plus = await scale(page);
    expect(plus).toBeGreaterThan(initial);
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    expect(await scale(page)).toBeLessThan(plus);
    expect(await acted(page, { key: "=" })).toBe(true);
    expect(await acted(page, { key: "=", ctrlKey: true })).toBe(false); // the browser's own page zoom

    await bar(page).getByRole("button", { name: "Fit View", exact: true }).click();
    const fitted = await scale(page);
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.dblclick(pane.x + 60, pane.y + 60); // empty pane: double-click belongs to editing, not zoom
    expect(await scale(page)).toBe(fitted);
    expect(saves).toHaveLength(0);
  });

  test("Undo and Redo (bar buttons and Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y) act on unsaved changes only", async ({ page }) => {
    const undo = bar(page).getByRole("button", { name: "Undo", exact: true });
    const redo = bar(page).getByRole("button", { name: "Redo", exact: true });
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    expect(await acted(page, { key: "z", ctrlKey: true })).toBe(false); // nothing to undo: the key is left alone
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("2 connections");
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();

    await page.keyboard.press("Control+z");
    await expect(status(page)).toContainText("1 connection");
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await page.keyboard.press("Control+Shift+Z");
    await expect(status(page)).toContainText("2 connections");
    await page.keyboard.press("Control+z");
    await expect(status(page)).toContainText("1 connection");
    await page.keyboard.press("Control+y");
    await expect(status(page)).toContainText("2 connections");
    await undo.click();
    await expect(status(page)).toContainText("1 connection");
    await redo.click();
    await expect(status(page)).toContainText("2 connections");
    expect(saves).toHaveLength(0);

    await headerSave(page).click();
    await expect(status(page)).toContainText("All changes saved");
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    expect(await acted(page, { key: "z", ctrlKey: true })).toBe(false);
    expect(Object.keys((await draftOf(page, projectId)).document.edges)).toHaveLength(2);
  });

  test("Ctrl/Cmd+S saves like the Save button and keeps the browser's save dialog away", async ({ page }) => {
    expect(await acted(page, { key: "s", ctrlKey: true })).toBe(true); // nothing to save: still no browser dialog
    expect(saves).toHaveLength(0);
    await connect(page, ids.payId, ids.shipId);
    await expect(headerSave(page)).toBeEnabled();
    expect(saves).toHaveLength(0);
    await page.keyboard.press("Control+s");
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(1);
    expect(Object.keys((await draftOf(page, projectId)).document.edges)).toHaveLength(2);
    await connect(page, ids.startId, ids.shipId);
    await expect(headerSave(page)).toBeEnabled();
    await page.keyboard.press("Meta+s");
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(2);
  });

  test("shortcuts do nothing while typing in the inline editor or the inspector, or while a dialog is open", async ({ page }) => {
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("2 connections");
    const before = await scale(page);

    // The inline step-name editor keeps + - and Ctrl+Z / Ctrl+S for itself.
    await nodeAt(page, ids.payId).locator(".step-label").dblclick();
    const editor = nodeAt(page, ids.payId).getByLabel("Step name");
    await expect(editor).toBeFocused();
    await page.keyboard.type("+-=");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+Z");
    await expect(status(page)).toContainText("2 connections");
    expect(await scale(page)).toBe(before);
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    // The inspector's Name field.
    await nodeAt(page, ids.payId).locator(".step-kind").dblclick();
    const name = page.locator("#right-panel").getByLabel("Name");
    await name.click();
    await name.press("End");
    await page.keyboard.type("+-");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    await expect(status(page)).toContainText("2 connections");
    expect(await scale(page)).toBe(before);
    expect(saves).toHaveLength(0);

    // A dialog owns the keyboard too.
    await page.getByRole("button", { name: "Add step" }).click();
    const dialog = page.getByRole("dialog", { name: "Add step" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    expect(await acted(page, { key: "z", ctrlKey: true })).toBe(false);
    expect(await acted(page, { key: "+" })).toBe(false);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(status(page)).toContainText("2 connections");
    expect(saves).toHaveLength(0);
  });

  test("at 390 px the bar sits clear of the shape panel and its buttons are touch-sized", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    const buttons = bar(page).getByRole("button");
    await expect(buttons).toHaveCount(5);
    const panel = (await page.locator(".shape-panel").boundingBox())!;
    const box = (await bar(page).boundingBox())!;
    const apart = box.x + box.width <= panel.x || panel.x + panel.width <= box.x || box.y + box.height <= panel.y || panel.y + panel.height <= box.y;
    expect(apart).toBe(true);
    for (const button of await buttons.all()) {
      const size = (await button.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("Canvas control bar (reader, mocked project)", () => {
  const projectId = "c1111111-1111-4111-8111-111111111111";
  const flowId = "d1111111-1111-4111-8111-111111111111";
  const start = "e1111111-1111-4111-8111-111111111111";
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Controls Reader");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const view = emptyDraftView();
    const draft = {
      ...view,
      document: {
        ...view.document,
        flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: "Intake", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null } },
        nodes: { [start]: { id: start, flowId, version: 1, behaviourVersion: 1, kind: "START", label: "Receive form", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] } },
        edges: {},
      },
      layout: { schemaVersion: 1, positions: { [start]: { x: 0, y: 0, version: 1 } }, directions: { [flowId]: "TB" }, edgeSides: {} },
    };
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [], truncated: false }, shared: { items: [{ id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" }], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerId: projectId }, draft } }));
    await page.goto(`/app/projects/${projectId}`);
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("a reader gets only the zoom group, zoom shortcuts work, and undo and save keys are left alone", async ({ page }) => {
    await expect(nodeAt(page, start)).toBeVisible();
    await expect(bar(page).getByRole("button")).toHaveCount(3);
    await expect(bar(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(bar(page).getByRole("button", { name: "Redo" })).toHaveCount(0);
    const initial = await scale(page);
    await bar(page).getByRole("button", { name: "Zoom In", exact: true }).click();
    expect(await scale(page)).toBeGreaterThan(initial);
    expect(await acted(page, { key: "-" })).toBe(true);
    expect(await acted(page, { key: "z", ctrlKey: true })).toBe(false);
    expect(await acted(page, { key: "y", ctrlKey: true })).toBe(false);
    expect(await acted(page, { key: "s", ctrlKey: true })).toBe(false);
  });
});
