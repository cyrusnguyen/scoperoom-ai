import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

type Seeded = { draftId: string; flowId: string; nodeIds: string[] };
const status = (page: Page) => page.locator(".studio-status");
const note = (page: Page) => page.locator(".placement-note");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
// Buffered position saves (Task 12): the header's Save, immediately left of Inspect.
const saveButton = (page: Page) => page.locator(".editor-header").getByRole("button", { name: "Save", exact: true });
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const itemsOf = (request: Request) => (request.postDataJSON() as { items: { nodeId: string }[] }).items.map((item) => item.nodeId);
// A beforeunload listener that calls preventDefault() is what makes the browser ask before leaving.
const warnsBeforeUnload = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** One flow with steps (a chain unless `connect` is false), created through the real command route. */
async function seedFlow(page: Page, projectId: string, labels: string[], { title = "Positions", connect = true } = {}): Promise<Seeded> {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds;
  };
  const [flowId] = await send({ command: "CREATE_FLOW", payload: { title, purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const nodeIds: string[] = [];
  for (const [index, label] of labels.entries()) {
    const [nodeId] = await send({ command: "ADD_NODE", payload: { flowId, kind: index ? "ACTION" : "START", label, description: "", actorLabel: "" } });
    if (index && connect) await send({ command: "ADD_EDGE", payload: { flowId, fromId: nodeIds[index - 1], toId: nodeId, condition: "" } });
    nodeIds.push(nodeId!);
  }
  return { draftId, flowId: flowId!, nodeIds };
}

/** A move from "another tab" of the same account, at the versions that tab last read (at most 20 steps). */
async function moveViaApi(page: Page, projectId: string, seeded: Seeded, targets: Record<string, { x: number; y: number }>) {
  const { positions } = (await draftOf(page, projectId)).layout;
  const items = Object.entries(targets).map(([nodeId, { x, y }]) => ({ nodeId, expectedPositionVersion: positions[nodeId]!.version, x, y }));
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${seeded.draftId}/positions`, { headers: headers(), data: { mode: "MOVE_NODES", flowId: seeded.flowId, items } });
  expect(response.status()).toBe(200);
}

/** A real pointer drag of one step (and any other selected steps) on the canvas, by a screen offset. */
async function drag(page: Page, nodeId: string, dx: number, dy: number) {
  const box = (await nodeAt(page, nodeId).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test.describe("saved positions and arrangement", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;
  let seeded: Seeded;
  let moves: Request[];

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Positions Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Positions project");
    seeded = await seedFlow(page, projectId, ["Start", "Middle", "End"]);
    moves = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/positions")) moves.push(request); });
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, seeded.nodeIds[1]!)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("a drag stays unsaved and sends nothing; Save sends it once, it survives a reload, and never touches the document", async ({ page }) => {
    const before = await draftOf(page, projectId);
    const middle = seeded.nodeIds[1]!;
    await expect(saveButton(page)).toBeDisabled();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await drag(page, middle, 180, 40);
    await expect(status(page)).toContainText("Unsaved positions");
    const moved = await nodeAt(page, middle).getAttribute("style");
    await page.waitForTimeout(500);
    expect(moves).toHaveLength(0);
    expect((await draftOf(page, projectId)).layout).toEqual(before.layout);
    // The leave/reload guard warns while a moved step is unsaved.
    expect(await warnsBeforeUnload(page)).toBe(true);

    await saveButton(page).click();
    await expect(status(page)).toContainText("Positions saved");
    await expect(saveButton(page)).toBeDisabled();
    expect(moves).toHaveLength(1);
    expect(await warnsBeforeUnload(page)).toBe(false);
    const after = await draftOf(page, projectId);
    expect(after.layout.positions[middle]!.version).toBe(2);
    expect(after.layout.positions[middle]!.x).not.toBe(before.layout.positions[middle]!.x);
    expect(after.documentRevision).toBe(before.documentRevision);
    expect(after.layoutRevision).toBe(before.layoutRevision + 1);
    expect(after.layout.positions[seeded.nodeIds[0]!]).toEqual(before.layout.positions[seeded.nodeIds[0]!]);
    const { x, y } = after.layout.positions[middle]!;
    expect(moved).toContain(`translate(${x}px, ${y}px)`);
    await page.reload();
    await expect(nodeAt(page, middle)).toHaveAttribute("style", new RegExp(`translate\\(${x}px, ${y}px\\)`));
  });

  test("Save sends every step moved across several drags in one all-or-nothing request", async ({ page }) => {
    const [first, middle, last] = seeded.nodeIds;
    await nodeAt(page, first!).click();
    await nodeAt(page, last!).click({ modifiers: ["Control"] });
    await drag(page, first!, 160, 0);
    await nodeAt(page, middle!).click();
    await drag(page, middle!, -120, 30);
    await drag(page, middle!, -40, 30); // a second drag of the same step keeps one unsaved move for it
    await expect(status(page)).toContainText("Unsaved positions");
    expect(moves).toHaveLength(0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("Positions saved");
    expect(moves).toHaveLength(1);
    expect(itemsOf(moves[0]!).sort()).toEqual([first!, middle!, last!].sort());
    const draft = await draftOf(page, projectId);
    expect(seeded.nodeIds.map((nodeId) => draft.layout.positions[nodeId]!.version)).toEqual([2, 2, 2]);
  });

  test("autosave sends unsaved moves 10 seconds after they start waiting, never sooner", async ({ page }) => {
    await page.clock.install();
    await page.reload();
    const middle = seeded.nodeIds[1]!;
    await expect(nodeAt(page, middle)).toBeVisible();
    await drag(page, middle, 150, 0);
    await expect(status(page)).toContainText("Unsaved positions");
    await page.clock.fastForward(8_000);
    await page.waitForTimeout(300);
    expect(moves).toHaveLength(0);
    await page.clock.fastForward(2_500);
    await expect(status(page)).toContainText("Positions saved");
    expect(moves).toHaveLength(1);
    expect(itemsOf(moves[0]!)).toEqual([middle]);
    // Clean again: no timer, so no further request however long the Studio stays open.
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(300);
    expect(moves).toHaveLength(1);
  });

  test("the inspector's position form saves its move at once, and arrow keys on the canvas never move or save", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await nodeAt(page, middle).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    expect(moves).toHaveLength(0);
    await expect(status(page)).not.toContainText("Unsaved positions");

    await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Middle/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByLabel("X", { exact: true }).fill("420");
    await page.getByLabel("Y", { exact: true }).fill("-35.5");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(status(page)).toContainText("Positions saved");
    expect(moves).toHaveLength(1);
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 420, y: -35.5, version: 2 });
    await page.getByLabel("X", { exact: true }).fill("200000");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Enter numbers from -100000 to 100000.")).toBeVisible();
    expect(moves).toHaveLength(1);
  });

  test("a save that meets someone else's move keeps my placement until I choose", async ({ page }) => {
    const [, middle, end] = seeded.nodeIds;
    await moveViaApi(page, projectId, seeded, { [middle!]: { x: 900, y: 900 } });
    await drag(page, middle!, 150, 0);
    await saveButton(page).click();
    await expect(note(page)).toContainText("Someone moved these steps first");
    const mine = await nodeAt(page, middle!).getAttribute("style");
    expect(mine).not.toContain("translate(900px, 900px)");
    await expect(saveButton(page)).toBeDisabled(); // the refused save is resolved first
    await note(page).getByRole("button", { name: "Apply my placement" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(status(page)).toContainText("Positions saved");
    const applied = (await draftOf(page, projectId)).layout.positions[middle!]!;
    expect(applied.version).toBe(3);
    expect(mine).toContain(`translate(${applied.x}px, ${applied.y}px)`);

    await moveViaApi(page, projectId, seeded, { [end!]: { x: 700, y: 700 } });
    await drag(page, end!, -120, 0);
    await saveButton(page).click();
    await expect(note(page)).toContainText("Someone moved these steps first");
    await note(page).getByRole("button", { name: "Keep saved positions" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(nodeAt(page, end!)).toHaveAttribute("style", /translate\(700px, 700px\)/);
    await expect(status(page)).not.toContainText("Unsaved positions");
    expect((await draftOf(page, projectId)).layout.positions[end!]).toEqual({ x: 700, y: 700, version: 2 });
    expect(moves).toHaveLength(3);
  });

  test("Undo reverts my latest unsaved drop locally; after a save it restores my last move and refuses once someone else moved the step", async ({ page }) => {
    const start = seeded.nodeIds[0]!;
    const original = (await draftOf(page, projectId)).layout.positions[start]!;
    const undo = () => status(page).getByRole("button", { name: "Undo move" });
    await drag(page, start, 200, 0);
    const firstDrop = await nodeAt(page, start).getAttribute("style");
    await drag(page, start, 0, 120);
    await undo().click();
    await expect(nodeAt(page, start)).toHaveAttribute("style", firstDrop!);
    await undo().click();
    await expect(nodeAt(page, start)).toHaveAttribute("style", new RegExp(`translate\\(${original.x}px, ${original.y}px\\)`));
    await expect(status(page)).not.toContainText("Unsaved positions");
    await expect(undo()).toHaveCount(0);
    expect(moves).toHaveLength(0);

    await drag(page, start, 200, 0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("Positions saved");
    await undo().click();
    await expect(undo()).toHaveCount(0);
    expect((await draftOf(page, projectId)).layout.positions[start]).toEqual({ x: original.x, y: original.y, version: 3 });

    await drag(page, start, 200, 0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("Positions saved");
    await expect(undo()).toBeVisible();
    await moveViaApi(page, projectId, seeded, { [start]: { x: 50, y: 50 } });
    await undo().click();
    await expect(status(page)).toContainText("A step moved since your last move, so it can’t be undone.");
    expect((await draftOf(page, projectId)).layout.positions[start]).toEqual({ x: 50, y: 50, version: 5 });
  });

  test("Arrange previews first, applies exactly the preview, and Cancel saves nothing", async ({ page }) => {
    const toolbar = page.locator(".studio-toolbar");
    const before = await draftOf(page, projectId);
    await toolbar.getByRole("button", { name: "Arrange" }).click();
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByLabel("Arrangement preview")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await draftOf(page, projectId)).layoutRevision).toBe(before.layoutRevision);

    await toolbar.getByRole("button", { name: "Arrange" }).click();
    await dialog.getByLabel("Direction").selectOption({ label: "Left to right" });
    const previewed = page.waitForResponse((response) => response.url().endsWith("/arrangement-preview"));
    await dialog.getByRole("button", { name: "Preview" }).click();
    const preview = await (await previewed).json() as { positions: Record<string, { x: number; y: number }> };
    await dialog.getByRole("button", { name: "Apply arrangement" }).click();
    await expect(dialog).toBeHidden();
    const after = await draftOf(page, projectId);
    expect(after.layout.directions[seeded.flowId]).toBe("LR");
    for (const nodeId of seeded.nodeIds) expect({ x: after.layout.positions[nodeId]!.x, y: after.layout.positions[nodeId]!.y }).toEqual(preview.positions[nodeId]);
    expect(after.documentRevision).toBe(before.documentRevision);
  });

  test("Arrange saves unsaved moves first, and does not open while they cannot be saved", async ({ page }) => {
    const [start, middle] = seeded.nodeIds;
    const toolbar = page.locator(".studio-toolbar");
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await drag(page, middle!, 150, 0);
    await toolbar.getByRole("button", { name: "Arrange" }).click();
    await expect(dialog).toBeVisible();
    expect(moves).toHaveLength(1);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(2);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await moveViaApi(page, projectId, seeded, { [start!]: { x: 600, y: 600 } });
    await drag(page, start!, 150, 0);
    await toolbar.getByRole("button", { name: "Arrange" }).click();
    await expect(note(page).filter({ hasText: "Someone moved these steps first" })).toBeVisible();
    await expect(note(page).filter({ hasText: "Arrange didn’t open because your moved steps aren’t saved yet." })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(moves).toHaveLength(2);
  });

  test("an arrangement meets a newer move: Apply is refused and a new preview applies", async ({ page }) => {
    await page.locator(".studio-toolbar").getByRole("button", { name: "Arrange" }).click();
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("button", { name: "Apply arrangement" })).toBeVisible();
    await moveViaApi(page, projectId, seeded, { [seeded.nodeIds[2]!]: { x: 640, y: 640 } });
    await dialog.getByRole("button", { name: "Apply arrangement" }).click();
    await expect(dialog.getByRole("alert")).toContainText("The flow changed since this preview");
    await dialog.getByRole("button", { name: "Preview" }).click();
    await dialog.getByRole("button", { name: "Apply arrangement" }).click();
    await expect(dialog).toBeHidden();
    expect((await draftOf(page, projectId)).layout.positions[seeded.nodeIds[2]!]).not.toEqual({ x: 640, y: 640, version: 2 });
  });

  test("a saving move locks its steps; an unconfirmed save retries with the same key, saves once, and pauses autosave until then", async ({ page }) => {
    const [start, middle] = seeded.nodeIds;
    await page.clock.install();
    await page.reload();
    await expect(nodeAt(page, middle!)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/positions", async (route) => { await held; await route.continue(); });
    await drag(page, middle!, 150, 0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("Saving positions…");
    await expect(saveButton(page)).toBeDisabled();
    await drag(page, middle!, 60, 60); // locked while its save is in flight: nothing new to save
    await drag(page, start!, 60, 0); // and nothing else moves while one request is in flight
    release();
    await expect(status(page)).toContainText("Positions saved");
    await expect(saveButton(page)).toBeDisabled();
    expect(moves).toHaveLength(1);
    await page.unroute("**/positions");

    const keys: string[] = [];
    let lose = true;
    await page.route("**/positions", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (!lose) return route.continue();
      lose = false;
      await route.fetch(); // the server saves it, then the acknowledgement is lost
      return route.abort("connectionreset");
    });
    await drag(page, middle!, 0, 120);
    await saveButton(page).click();
    await expect(note(page)).toContainText("We couldn’t confirm the new position.");
    // Unresolved: autosave waits for the person rather than sending the move again under a new key.
    await page.clock.fastForward(25_000);
    await page.waitForTimeout(300);
    expect(keys).toHaveLength(1);
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(status(page)).toContainText("Positions saved");
    await page.unroute("**/positions");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(3);
  });

  test("an in-flight save keeps commands locked and its placement shown after the Studio remounts", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await expect(nodeAt(page, middle)).toBeVisible();
    const sidebar = page.locator("#projects-nav");
    await sidebar.getByRole("button", { name: "Other project", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    await sidebar.getByRole("button", { name: "Positions project", exact: true }).click();
    await expect(nodeAt(page, middle)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const commands: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/commands")) commands.push(request.url()); });
    await page.route("**/positions", async (route) => { await held; await route.continue(); });
    try {
      await drag(page, middle, 150, 0);
      await saveButton(page).click();
      await expect(status(page)).toContainText("Saving positions…");
      const attempted = await nodeAt(page, middle).getAttribute("style");
      // Browser history remounts the keyed provider without the switch guard.
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
      await page.goForward();
      await expect(page.getByRole("heading", { level: 1, name: "Positions project" })).toBeVisible();
      await expect(status(page)).toContainText("Saving positions…");
      await expect(page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true })).toBeDisabled();
      await expect(saveButton(page)).toBeDisabled();
      await expect(nodeAt(page, middle)).toHaveAttribute("style", attempted!);
      expect(moves).toHaveLength(1);
      release();
      await expect(status(page)).toContainText("Positions saved");
      await expect(page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true })).toBeEnabled();
      expect(commands).toHaveLength(0);
      expect((await draftOf(page, projectId)).layout.positions[middle]!.version).toBe(2);
    } finally { release(); }
  });

  test("switching flow or project saves moved steps first", async ({ page }) => {
    const [, middle, end] = seeded.nodeIds;
    await seedFlow(page, projectId, ["Other start"], { title: "Second flow" });
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await expect(nodeAt(page, middle!)).toBeVisible();

    await drag(page, middle!, 150, 0);
    await page.locator(".flow-switch").click();
    await page.getByRole("dialog", { name: "Flows" }).locator(".item-row").filter({ hasText: "Second flow" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Second flow");
    expect(moves).toHaveLength(1);
    expect(itemsOf(moves[0]!)).toEqual([middle!]);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(2);

    await page.locator(".flow-switch").click();
    await page.getByRole("dialog", { name: "Flows" }).locator(".item-row").filter({ hasText: "Positions" }).click();
    await expect(nodeAt(page, end!)).toBeVisible();
    await drag(page, end!, -150, 0);
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Unsaved changes/ })).toHaveCount(0);
    expect(moves).toHaveLength(2);
    expect((await draftOf(page, projectId)).layout.positions[end!]!.version).toBe(2);
  });

  test("a project switch whose save is refused asks first, and Discard drops the moved steps", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await expect(nodeAt(page, middle)).toBeVisible();
    await moveViaApi(page, projectId, seeded, { [middle]: { x: 800, y: 800 } });
    await drag(page, middle, 150, 0);
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Unsaved changes in Positions project" });
    await expect(guard).toBeVisible();
    await expect(note(page)).toContainText("Someone moved these steps first");
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.locator("#projects-nav").getByRole("button", { name: "Positions project", exact: true }).click();
    await expect(nodeAt(page, middle)).toHaveAttribute("style", /translate\(800px, 800px\)/);
    await expect(status(page)).not.toContainText("Unsaved positions");
    expect(moves).toHaveLength(1);
  });
});

test.describe("chunked position saves", () => {
  test("more than 20 unsaved steps save in chunks of 20, and \"Positions saved\" waits for the last one", async ({ page }) => {
    test.setTimeout(150_000);
    const admin = adminClient();
    const database = await openDatabase();
    const users: string[] = [];
    try {
      const { authUserId } = await signIn(page, admin, users, "Chunks Owner");
      await entitle(database, authUserId);
      const projectId = await createProjectViaApi(page, "Chunks project");
      const seeded = await seedFlow(page, projectId, Array.from({ length: 23 }, (_, index) => `S${index + 1}`), { title: "Many", connect: false });
      // A 6-column grid, so every step is on screen and clickable.
      const grid = Object.fromEntries(seeded.nodeIds.map((nodeId, index) => [nodeId, { x: (index % 6) * 260, y: Math.floor(index / 6) * 180 }]));
      await moveViaApi(page, projectId, seeded, Object.fromEntries(Object.entries(grid).slice(0, 20)));
      await moveViaApi(page, projectId, seeded, Object.fromEntries(Object.entries(grid).slice(20)));
      const moves: Request[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/positions")) moves.push(request); });
      await page.goto(`/app/projects/${projectId}`);
      const [first, ...rest] = seeded.nodeIds;
      await expect(nodeAt(page, first!)).toBeVisible();

      // One drag of more than 20 steps is still refused.
      await nodeAt(page, first!).click();
      for (const nodeId of rest.slice(0, 20)) await nodeAt(page, nodeId).click({ modifiers: ["Control"] });
      await drag(page, first!, 20, 30);
      await expect(page.locator(".canvas-note")).toContainText("Move up to 20 steps at a time.");
      await expect(status(page)).not.toContainText("Unsaved positions");

      // 20 steps in one drag, then two more one at a time: 22 unsaved moves.
      await nodeAt(page, rest[19]!).click({ modifiers: ["Control"] });
      await drag(page, first!, 20, 30);
      for (const nodeId of rest.slice(20)) {
        await nodeAt(page, nodeId).click();
        await drag(page, nodeId, 20, 30);
      }
      await expect(status(page)).toContainText("Unsaved positions");
      expect(moves).toHaveLength(0);
      const before = await draftOf(page, projectId);

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let seen = 0;
      await page.route("**/positions", async (route) => { seen += 1; if (seen === 2) await held; await route.continue(); });
      try {
        await saveButton(page).click();
        await expect.poll(() => moves.length).toBe(2);
        await expect(status(page)).toContainText("Saving positions…");
        await expect(status(page)).not.toContainText("Positions saved");
        release();
        await expect(status(page)).toContainText("Positions saved");
      } finally { release(); }
      expect(moves.map((request) => itemsOf(request).length)).toEqual([20, 2]);
      expect(new Set(moves.flatMap(itemsOf))).toEqual(new Set([first!, ...rest.slice(0, 19), ...rest.slice(20)]));
      const after = await draftOf(page, projectId);
      expect(seeded.nodeIds.filter((nodeId) => after.layout.positions[nodeId]!.version === before.layout.positions[nodeId]!.version + 1)).toHaveLength(22);
      expect(after.layout.positions[rest[19]!]).toEqual(before.layout.positions[rest[19]!]);
    } finally {
      try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
    }
  });
});
