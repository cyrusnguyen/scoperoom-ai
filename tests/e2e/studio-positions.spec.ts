import { randomUUID } from "node:crypto";
import { expect, type Page, type Request } from "@playwright/test";
import { interceptRealtime } from "./collaboration-fixtures";
import { test } from "./studio-fixtures";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

type Seeded = { draftId: string; flowId: string; nodeIds: string[] };
type Batch = { commands: unknown[]; moves: { flowId: string; items: { nodeId: string; expectedPositionVersion: number }[] }[] };
const status = (page: Page) => page.locator(".studio-status");
const note = (page: Page) => page.locator(".save-note");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
// Save covers every change (Task 14b): the header's Save, immediately left of Inspect.
const saveButton = headerSave;
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const itemsOf = (request: Request) => (request.postDataJSON() as Batch).moves.flatMap((group) => group.items.map((item) => item.nodeId));
const STALE = "Someone else changed this draft first, so your changes weren’t saved.";
// A beforeunload listener that calls preventDefault() is what makes the browser ask before leaving.
const warnsBeforeUnload = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** One flow with steps (a chain unless `connect` is false), created in one real batch. */
async function seedFlow(page: Page, projectId: string, labels: string[], { title = "Positions", connect = true } = {}): Promise<Seeded> {
  const flowId = randomUUID();
  const nodeIds = labels.map(() => randomUUID());
  const commands: { command: string; payload: Record<string, unknown>; proposedIds: string[] }[] = [
    { command: "CREATE_FLOW", payload: { title, purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
  ];
  for (const [index, label] of labels.entries()) {
    commands.push({ command: "ADD_NODE", payload: { flowId, kind: index ? "ACTION" : "START", label, description: "", actorLabel: "" }, proposedIds: [nodeIds[index]!] });
    if (index && connect) commands.push({ command: "ADD_EDGE", payload: { flowId, fromId: nodeIds[index - 1], toId: nodeIds[index], condition: "" }, proposedIds: [randomUUID()] });
  }
  const draftId = await seedStudioChanges(page, projectId, commands);
  return { draftId, flowId, nodeIds };
}

/** A move from "another tab" of the same account, at the versions that tab last read (at most 20 steps). */
async function moveViaApi(page: Page, projectId: string, seeded: Seeded, targets: Record<string, { x: number; y: number }>) {
  const { positions } = (await draftOf(page, projectId)).layout;
  const items = Object.entries(targets).map(([nodeId, { x, y }]) => ({ nodeId, expectedPositionVersion: positions[nodeId]!.version, x, y }));
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${seeded.draftId}/positions`, { headers: headers(), data: { mode: "MOVE_NODES", flowId: seeded.flowId, items } });
  expect(response.status()).toBe(200);
}

/**
 * Withhold committed hints for save-time recovery tests. Subscription and status reconciliation remain active,
 * so a stale-edit setup must queue its local change before the peer saves rather than assume the page has not read it.
 */
async function withholdHints(page: Page, nodeId: string) {
  (await interceptRealtime(page)).dropEvents = true;
  await page.reload();
  await expect(nodeAt(page, nodeId)).toBeVisible();
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
  let projectId: string;
  let seeded: Seeded;
  /** Batch saves (POST D/changes): the only way the Studio saves a move now. */
  let saves: Request[];
  let positionWrites: Request[];

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    projectId = await createProjectViaApi(page, "Positions project");
    seeded = await seedFlow(page, projectId, ["Start", "Middle", "End"]);
    saves = [];
    positionWrites = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().endsWith("/changes")) saves.push(request);
      if (request.url().endsWith("/positions")) positionWrites.push(request);
    });
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, seeded.nodeIds[1]!)).toBeVisible();
  });

  test("a drag stays unsaved and sends nothing; Save sends it once, it survives a reload, and never touches the document", async ({ page }) => {
    const before = await draftOf(page, projectId);
    const middle = seeded.nodeIds[1]!;
    await expect(saveButton(page)).toBeDisabled();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await drag(page, middle, 180, 40);
    await expect(status(page)).toContainText("Unsaved changes");
    const moved = await nodeAt(page, middle).getAttribute("style");
    await page.waitForTimeout(500);
    expect(saves).toHaveLength(0);
    expect((await draftOf(page, projectId)).layout).toEqual(before.layout);
    // The leave/reload guard warns while a moved step is unsaved.
    expect(await warnsBeforeUnload(page)).toBe(true);

    await saveButton(page).click();
    await expect(status(page)).toContainText("All changes saved");
    await expect(saveButton(page)).toBeDisabled();
    expect(saves).toHaveLength(1);
    expect((saves[0]!.postDataJSON() as Batch).commands).toEqual([]);
    expect(positionWrites).toHaveLength(0);
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
    await drag(page, middle!, -40, 30); // a second drag of the same step sends one move for it
    await expect(status(page)).toContainText("Unsaved changes");
    expect(saves).toHaveLength(0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(1);
    expect(itemsOf(saves[0]!).sort()).toEqual([first!, middle!, last!].sort());
    const draft = await draftOf(page, projectId);
    expect(seeded.nodeIds.map((nodeId) => draft.layout.positions[nodeId]!.version)).toEqual([2, 2, 2]);
  });

  test("autosave sends unsaved moves 10 seconds after they start waiting, never sooner", async ({ page }) => {
    await page.clock.install();
    await page.reload();
    const middle = seeded.nodeIds[1]!;
    await expect(nodeAt(page, middle)).toBeVisible();
    await drag(page, middle, 150, 0);
    await expect(status(page)).toContainText("Unsaved changes");
    await page.clock.fastForward(8_000);
    await page.waitForTimeout(300);
    expect(saves).toHaveLength(0);
    await page.clock.fastForward(2_500);
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(1);
    expect(itemsOf(saves[0]!)).toEqual([middle]);
    // Clean again: no timer, so no further request however long the Studio stays open.
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(300);
    expect(saves).toHaveLength(1);
  });

  test("the inspector's position form saves its move at once, and arrow keys on the canvas never move or save", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await nodeAt(page, middle).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    expect(saves).toHaveLength(0);
    await expect(status(page)).not.toContainText("Unsaved changes");

    await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Middle/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByLabel("X", { exact: true }).fill("420");
    await page.getByLabel("Y", { exact: true }).fill("-35.5");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(status(page)).toContainText("All changes saved");
    expect(saves).toHaveLength(1);
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 420, y: -35.5, version: 2 });
    await page.getByLabel("X", { exact: true }).fill("200000");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Enter numbers from -100000 to 100000.")).toBeVisible();
    expect(saves).toHaveLength(1);
  });

  test("typed coordinates survive a remote move and project switch until explicitly reviewed or discarded", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await expect(nodeAt(page, middle)).toBeVisible();
    await nodeAt(page, middle).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    const original = (await draftOf(page, projectId)).layout.positions[middle]!;
    await page.getByLabel("X", { exact: true }).fill("420");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Unsaved changes in Positions project" });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "Stay" }).click();
    await expect(page.getByLabel("X", { exact: true })).toHaveValue("420");
    await moveViaApi(page, projectId, seeded, { [middle]: { x: 900, y: 900 } });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const conflict = page.locator(".position-form .inline-note");
    await expect(conflict).toContainText("Position changed");
    await expect(page.getByLabel("X", { exact: true })).toHaveValue("420");
    await expect(page.getByLabel("Y", { exact: true })).toHaveValue(String(original.y));
    await expect(conflict).toContainText("Saved position(900, 900)");
    await expect(page.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    expect(saves).toHaveLength(0);
    await conflict.getByRole("button", { name: "Move my edit" }).click();
    await expect(status(page)).toContainText("All changes saved");
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 420, y: original.y, version: 3 });
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.getByLabel("X", { exact: true }).fill("600");
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.locator("#projects-nav").getByRole("button", { name: "Positions project", exact: true }).click();
    await expect(page.getByLabel("X", { exact: true })).toHaveValue("420");
  });

  test("a drag after a queued coordinate move preserves its guard when a peer move is read", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await withholdHints(page, middle);
    const original = (await draftOf(page, projectId)).layout.positions[middle]!;
    await nodeAt(page, middle).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByLabel("X", { exact: true }).fill("420");
    // Fail admission, leaving the coordinate move queued without sending a batch.
    let unavailable = true;
    await page.route(`**/api/projects/${projectId}/status`, async (route) => {
      if (unavailable) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Unavailable", retryable: true } } });
      else await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(status(page)).toContainText("Not saved");
    expect(saves).toHaveLength(0);
    await moveViaApi(page, projectId, seeded, { [middle]: { x: 900, y: 900 } });
    unavailable = false;
    const read = page.waitForResponse((response) => response.url().endsWith(`/drafts/${seeded.draftId}`) && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(((await (await read).json()) as DraftView).layout.positions[middle]!.version).toBe(original.version + 1);
    await expect(note(page)).toContainText("Newer saved changes are available.");
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(nodeAt(page, middle)).toBeVisible();
    await drag(page, middle, 60, 20);
    const saving = page.waitForResponse((response) => response.url().endsWith("/changes") && response.request().method() === "POST");
    await saveButton(page).click();
    expect((await saving).status()).toBe(409);
    expect((saves[0]!.postDataJSON() as Batch).moves[0]!.items[0]!.expectedPositionVersion).toBe(original.version);
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 900, y: 900, version: original.version + 1 });
  });

  test("another drag of the same node during my save uses that save's resulting version", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/changes", async (route) => { await held; await route.continue(); }, { times: 1 });
    try {
      await drag(page, middle, 100, 0);
      await saveButton(page).click();
      await expect(status(page)).toContainText("Saving…");
      await drag(page, middle, 80, 30);
      release();
      await expect(status(page)).toContainText("All changes saved");
      expect(saves).toHaveLength(2);
      expect((await draftOf(page, projectId)).layout.positions[middle]!.version).toBe(3);
    } finally { release(); }
  });

  test("a deleted node retains typed coordinates for copy and discard", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await nodeAt(page, middle).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByLabel("X", { exact: true }).fill("420");
    const before = await draftOf(page, projectId);
    const removeEdgeIds = Object.values(before.document.edges).filter((edge) => edge.fromId === middle || edge.toId === middle).map((edge) => edge.id);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${seeded.draftId}/changes`, { headers: headers(), data: {
      commands: [{ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: before.documentRevision, payload: { flowId: seeded.flowId, nodeIds: [middle], removeEdgeIds }, proposedIds: [] }], moves: [],
    } });
    expect(response.status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "This step was removed" })).toBeVisible();
    await expect(page.getByLabel("Your unsaved text")).toContainText("X: 420");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.locator("#right-panel").getByRole("button", { name: "Discard", exact: true }).click();
    expect(await warnsBeforeUnload(page)).toBe(false);
    expect((await draftOf(page, projectId)).document.nodes[middle]).toBeUndefined();
  });

  test("a remote saved move during a pointer drag cannot replace the drag's captured version", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    const original = (await draftOf(page, projectId)).layout.positions[middle]!;
    const box = (await nodeAt(page, middle).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + 150, y + 20, { steps: 5 });
      const read = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/drafts/${seeded.draftId}`));
      await moveViaApi(page, projectId, seeded, { [middle]: { x: 900, y: 900 } });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await read;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    } finally { await page.mouse.up(); }
    await saveButton(page).click();
    await expect(note(page)).toContainText(STALE);
    await expect(note(page).locator(".conflict-list")).toContainText("Saved value(900, 900)");
    const body = saves[0]!.postDataJSON() as { moves: { items: { nodeId: string; expectedPositionVersion: number }[] }[] };
    expect(body.moves.flatMap((group) => group.items).find((item) => item.nodeId === middle)!.expectedPositionVersion).toBe(original.version);
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 900, y: 900, version: original.version + 1 });
  });

  test("a save that meets someone else's move shows theirs and mine, and keeps my placement until I choose", async ({ page }) => {
    const [, middle, end] = seeded.nodeIds;
    await withholdHints(page, middle!);
    const before = await draftOf(page, projectId);
    await drag(page, middle!, 150, 0);
    await moveViaApi(page, projectId, seeded, { [middle!]: { x: 900, y: 900 } });
    const refused = page.waitForResponse((response) => response.url().endsWith("/changes") && response.request().method() === "POST");
    await saveButton(page).click();
    expect((await refused).status()).toBe(409);
    expect((saves[0]!.postDataJSON() as Batch).moves.flatMap((group) => group.items).find((item) => item.nodeId === middle)!.expectedPositionVersion).toBe(before.layout.positions[middle!]!.version);
    await expect(note(page)).toContainText(STALE);
    const mine = await nodeAt(page, middle!).getAttribute("style");
    expect(mine).not.toContain("translate(900px, 900px)");
    await expect(saveButton(page)).toBeDisabled(); // the refused save is resolved first
    // Their position and mine are compared before anything is sent again.
    const compared = note(page).locator(".conflict-list");
    await expect(compared).toContainText("Move Middle");
    await expect(compared).toContainText("Saved value(900, 900)");
    const mineAt = /translate\((-?\d+)px, (-?\d+)px\)/.exec(mine!)!;
    await expect(compared).toContainText(`Your edit(${mineAt[1]}, ${mineAt[2]})`);
    await expect(compared).toContainText("Before your edit");
    await note(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(status(page)).toContainText("All changes saved");
    const applied = (await draftOf(page, projectId)).layout.positions[middle!]!;
    expect(applied.version).toBe(3);
    expect(mine).toContain(`translate(${applied.x}px, ${applied.y}px)`);

    await drag(page, end!, -120, 0);
    await moveViaApi(page, projectId, seeded, { [end!]: { x: 700, y: 700 } });
    await saveButton(page).click();
    await expect(note(page)).toContainText(STALE);
    await expect(note(page).locator(".conflict-list")).toContainText("Saved value(700, 700)");
    await note(page).locator(".conflict-list").getByRole("button", { name: "Keep theirs" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(nodeAt(page, end!)).toHaveAttribute("style", /translate\(700px, 700px\)/);
    await expect(status(page)).not.toContainText("Unsaved changes");
    expect((await draftOf(page, projectId)).layout.positions[end!]).toEqual({ x: 700, y: 700, version: 2 });
    expect(saves).toHaveLength(3);
  });

  test("Undo and Redo work on unsaved drops only, with no request; nothing can be undone after Save", async ({ page }) => {
    const start = seeded.nodeIds[0]!;
    const original = (await draftOf(page, projectId)).layout.positions[start]!;
    const undo = () => status(page).getByRole("button", { name: "Undo" });
    const redo = () => status(page).getByRole("button", { name: "Redo" });
    await drag(page, start, 200, 0);
    const firstDrop = await nodeAt(page, start).getAttribute("style");
    await drag(page, start, 0, 120);
    const secondDrop = await nodeAt(page, start).getAttribute("style");
    await undo().click();
    await expect(nodeAt(page, start)).toHaveAttribute("style", firstDrop!);
    await undo().click();
    await expect(nodeAt(page, start)).toHaveAttribute("style", new RegExp(`translate\\(${original.x}px, ${original.y}px\\)`));
    await expect(status(page)).not.toContainText("Unsaved changes");
    await expect(undo()).toHaveCount(0);
    await redo().click();
    await redo().click();
    await expect(nodeAt(page, start)).toHaveAttribute("style", secondDrop!);
    await expect(redo()).toHaveCount(0);
    expect(saves).toHaveLength(0);

    await saveButton(page).click();
    await expect(status(page)).toContainText("All changes saved");
    await expect(undo()).toHaveCount(0);
    await expect(redo()).toHaveCount(0);
    expect(saves).toHaveLength(1);
    expect((await draftOf(page, projectId)).layout.positions[start]!.version).toBe(2);
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

  test("an unconfirmed arrangement keeps its preview and retries the exact request", async ({ page }) => {
    await page.locator(".studio-toolbar").getByRole("button", { name: "Arrange" }).click();
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await dialog.getByRole("button", { name: "Preview" }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/positions", async (route) => {
      await held;
      // The arrangement commits, but its acknowledgement never reaches the browser.
      expect((await route.fetch()).status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });
    try {
      await dialog.getByRole("button", { name: "Apply arrangement" }).click();
      await expect(dialog.getByLabel("Direction")).toBeDisabled();
      release();
      await expect(dialog.getByRole("alert")).toContainText("We couldn’t confirm the arrangement");
      await expect(dialog.getByLabel("Direction")).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Preview again" })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Apply again" })).toBeEnabled();
      const committed = await draftOf(page, projectId);
      await dialog.getByRole("button", { name: "Apply again" }).click();
      await expect(dialog).toBeHidden();
      expect(positionWrites).toHaveLength(2);
      expect(positionWrites[1]!.headers()["idempotency-key"]).toBe(positionWrites[0]!.headers()["idempotency-key"]);
      expect(positionWrites[1]!.postData()).toBe(positionWrites[0]!.postData());
      expect((await draftOf(page, projectId)).layoutRevision).toBe(committed.layoutRevision);
    } finally { release(); }
  });

  test("Arrange saves unsaved changes first, and does not open while they cannot be saved", async ({ page }) => {
    const [start, middle] = seeded.nodeIds;
    await withholdHints(page, start!);
    const toolbar = page.locator(".studio-toolbar");
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await drag(page, middle!, 150, 0);
    await toolbar.getByRole("button", { name: "Arrange" }).click();
    await expect(dialog).toBeVisible();
    expect(saves).toHaveLength(1);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(2);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await moveViaApi(page, projectId, seeded, { [start!]: { x: 600, y: 600 } });
    await drag(page, start!, 150, 0);
    await toolbar.getByRole("button", { name: "Arrange" }).click();
    await expect(note(page).filter({ hasText: STALE })).toBeVisible();
    const blocked = note(page).filter({ hasText: "Arrange didn’t open because your changes aren’t saved yet." });
    await expect(blocked).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(saves).toHaveLength(2);
    // Once the refused save is resolved, the Arrange note goes with it.
    await note(page).getByRole("button", { name: "Discard my changes" }).click();
    await expect(blocked).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);
  });

  test("an arrangement meets a newer move: Apply is refused and a new preview applies", async ({ page }) => {
    await withholdHints(page, seeded.nodeIds[2]!);
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

  test("a drag made while a save is in flight queues behind it; an unconfirmed save retries with the same key and pauses autosave", async ({ page }) => {
    const [start, middle] = seeded.nodeIds;
    await page.clock.install();
    await page.reload();
    await expect(nodeAt(page, middle!)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/changes", async (route) => { await held; await route.continue(); }, { times: 1 });
    await drag(page, middle!, 150, 0);
    await saveButton(page).click();
    await expect(status(page)).toContainText("Saving…");
    await expect(saveButton(page)).toBeDisabled();
    await drag(page, start!, 60, 0); // editing continues: this drop waits behind the save in flight
    await expect(nodeAt(page, start!)).not.toHaveAttribute("style", /translate\(0px, 0px\)/);
    release();
    await expect(status(page)).toContainText("All changes saved");
    expect(saves.map(itemsOf)).toEqual([[middle!], [start!]]);
    expect(saves[1]!.headers()["idempotency-key"]).not.toBe(saves[0]!.headers()["idempotency-key"]);
    let saved = await draftOf(page, projectId);
    expect([saved.layout.positions[middle!]!.version, saved.layout.positions[start!]!.version]).toEqual([2, 2]);

    let lose = true;
    await page.route("**/changes", async (route) => {
      if (!lose) return route.continue();
      lose = false;
      await route.fetch(); // the server saves it, then the acknowledgement is lost
      return route.abort("connectionreset");
    });
    await drag(page, middle!, 0, 120);
    await saveButton(page).click();
    await expect(note(page)).toContainText("We couldn’t confirm your changes.");
    // Unresolved: autosave waits for the person rather than sending anything else.
    await page.clock.fastForward(25_000);
    await page.waitForTimeout(300);
    expect(saves).toHaveLength(3);
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(status(page)).toContainText("All changes saved");
    await page.unroute("**/changes");
    expect(saves).toHaveLength(4);
    expect(saves[3]!.headers()["idempotency-key"]).toBe(saves[2]!.headers()["idempotency-key"]);
    expect(saves[3]!.postData()).toBe(saves[2]!.postData());
    saved = await draftOf(page, projectId);
    expect(saved.layout.positions[middle!]!.version).toBe(3);
  });

  test("an in-flight save stays locked and its changes shown after the Studio remounts, while editing stays open", async ({ page }) => {
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
    await page.route("**/changes", async (route) => { await held; await route.continue(); });
    try {
      await drag(page, middle, 150, 0);
      await saveButton(page).click();
      await expect(status(page)).toContainText("Saving…");
      const attempted = await nodeAt(page, middle).getAttribute("style");
      // Browser history remounts the keyed provider without the switch guard.
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
      await page.goForward();
      await expect(page.getByRole("heading", { level: 1, name: "Positions project" })).toBeVisible();
      await expect(status(page)).toContainText("Saving…");
      await expect(saveButton(page)).toBeDisabled();
      await expect(page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true })).toBeEnabled();
      await expect(nodeAt(page, middle)).toHaveAttribute("style", attempted!);
      expect(saves).toHaveLength(1);
      release();
      await expect(status(page)).toContainText("All changes saved");
      expect(commands).toHaveLength(0);
      expect(saves).toHaveLength(1);
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
    expect(saves).toHaveLength(1);
    expect(itemsOf(saves[0]!)).toEqual([middle!]);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(2);

    await page.locator(".flow-switch").click();
    await page.getByRole("dialog", { name: "Flows" }).locator(".item-row").filter({ hasText: "Positions" }).click();
    await expect(nodeAt(page, end!)).toBeVisible();
    await drag(page, end!, -150, 0);
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Unsaved changes/ })).toHaveCount(0);
    expect(saves).toHaveLength(2);
    expect((await draftOf(page, projectId)).layout.positions[end!]!.version).toBe(2);
  });

  test("a project switch whose save is refused asks first, and Discard drops the moved steps", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await createProjectViaApi(page, "Other project");
    await withholdHints(page, middle);
    const original = (await draftOf(page, projectId)).layout.positions[middle]!;
    await drag(page, middle, 150, 0);
    await expect(status(page)).toContainText("Unsaved changes");
    await moveViaApi(page, projectId, seeded, { [middle]: { x: 800, y: 800 } });
    const refused = page.waitForResponse((response) => response.url().endsWith("/changes") && response.request().method() === "POST");
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    const response = await refused;
    expect(response.status()).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("POSITION_CONFLICT");
    expect((saves[0]!.postDataJSON() as Batch).moves.flatMap((group) => group.items).find((item) => item.nodeId === middle)!.expectedPositionVersion).toBe(original.version);
    const guard = page.getByRole("dialog", { name: "Unsaved changes in Positions project" });
    await expect(guard).toBeVisible();
    await expect(guard).toContainText("unsaved change(s).");
    await expect(note(page)).toContainText(STALE);
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.locator("#projects-nav").getByRole("button", { name: "Positions project", exact: true }).click();
    await expect(nodeAt(page, middle)).toHaveAttribute("style", /translate\(800px, 800px\)/);
    await expect(status(page)).not.toContainText("Unsaved changes");
    await expect(note(page)).toHaveCount(0);
    expect(saves).toHaveLength(1);
  });
});

test.describe("large moves", () => {
  test("22 steps dragged at once save in one all-or-nothing batch (no 20-step cap per drag)", async ({ page }) => {
    test.setTimeout(150_000);
    const projectId = await createProjectViaApi(page, "Many project");
      const seeded = await seedFlow(page, projectId, Array.from({ length: 23 }, (_, index) => `S${index + 1}`), { title: "Many", connect: false });
      // A 6-column grid, so every step is on screen and clickable.
      const grid = Object.fromEntries(seeded.nodeIds.map((nodeId, index) => [nodeId, { x: (index % 6) * 260, y: Math.floor(index / 6) * 180 }]));
      await moveViaApi(page, projectId, seeded, Object.fromEntries(Object.entries(grid).slice(0, 20)));
      await moveViaApi(page, projectId, seeded, Object.fromEntries(Object.entries(grid).slice(20)));
      const saves: Request[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/changes")) saves.push(request); });
      await page.goto(`/app/projects/${projectId}`);
      const [first, ...rest] = seeded.nodeIds;
      await expect(nodeAt(page, first!)).toBeVisible();

      await nodeAt(page, first!).click();
      for (const nodeId of rest.slice(0, 21)) await nodeAt(page, nodeId).click({ modifiers: ["Control"] });
      await drag(page, first!, 20, 30);
      await expect(page.locator(".canvas-note")).toHaveCount(0);
      await expect(status(page)).toContainText("Unsaved changes");
      expect(saves).toHaveLength(0);
      const before = await draftOf(page, projectId);

      await saveButton(page).click();
      await expect(status(page)).toContainText("All changes saved");
      expect(saves.map((request) => itemsOf(request).length)).toEqual([22]);
      const after = await draftOf(page, projectId);
      expect(seeded.nodeIds.filter((nodeId) => after.layout.positions[nodeId]!.version === before.layout.positions[nodeId]!.version + 1)).toHaveLength(22);
      expect(after.layout.positions[rest[21]!]).toEqual(before.layout.positions[rest[21]!]);
  });
});
