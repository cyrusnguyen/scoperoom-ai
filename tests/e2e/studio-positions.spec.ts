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
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** One flow with a chain of steps, created through the real command route. */
async function seedFlow(page: Page, projectId: string, labels: string[]): Promise<Seeded> {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds;
  };
  const [flowId] = await send({ command: "CREATE_FLOW", payload: { title: "Positions", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const nodeIds: string[] = [];
  for (const [index, label] of labels.entries()) {
    const [nodeId] = await send({ command: "ADD_NODE", payload: { flowId, kind: index ? "ACTION" : "START", label, description: "", actorLabel: "" } });
    if (index) await send({ command: "ADD_EDGE", payload: { flowId, fromId: nodeIds[index - 1], toId: nodeId, condition: "" } });
    nodeIds.push(nodeId!);
  }
  return { draftId, flowId: flowId!, nodeIds };
}

/** A move from "another tab" of the same account, at the version that tab last read. */
async function moveViaApi(page: Page, projectId: string, seeded: Seeded, nodeId: string, x: number, y: number) {
  const version = (await draftOf(page, projectId)).layout.positions[nodeId]!.version;
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${seeded.draftId}/positions`, { headers: headers(), data: { mode: "MOVE_NODES", flowId: seeded.flowId, items: [{ nodeId, expectedPositionVersion: version, x, y }] } });
  expect(response.status()).toBe(200);
}

/** A real pointer drag of one step on the canvas, by a screen offset. */
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

  test("a drag saves once on drop, survives a reload, and never touches the document", async ({ page }) => {
    const before = await draftOf(page, projectId);
    const middle = seeded.nodeIds[1]!;
    await drag(page, middle, 180, 40);
    await expect(status(page)).toContainText("Positions saved");
    expect(moves).toHaveLength(1);
    const after = await draftOf(page, projectId);
    expect(after.layout.positions[middle]!.version).toBe(2);
    expect(after.layout.positions[middle]!.x).not.toBe(before.layout.positions[middle]!.x);
    expect(after.documentRevision).toBe(before.documentRevision);
    expect(after.layoutRevision).toBe(before.layoutRevision + 1);
    expect(after.layout.positions[seeded.nodeIds[0]!]).toEqual(before.layout.positions[seeded.nodeIds[0]!]);
    await page.reload();
    const { x, y } = after.layout.positions[middle]!;
    await expect(nodeAt(page, middle)).toHaveAttribute("style", new RegExp(`translate\\(${x}px, ${y}px\\)`));
  });

  test("dragging two selected steps saves both in one all-or-nothing request", async ({ page }) => {
    const [first, , last] = seeded.nodeIds;
    await nodeAt(page, first!).click();
    await nodeAt(page, last!).click({ modifiers: ["Control"] });
    await drag(page, first!, 160, 0);
    await expect(status(page)).toContainText("Positions saved");
    expect(moves).toHaveLength(1);
    expect((moves[0]!.postDataJSON() as { items: { nodeId: string }[] }).items.map((item) => item.nodeId).sort()).toEqual([first!, last!].sort());
    const draft = await draftOf(page, projectId);
    expect([draft.layout.positions[first!]!.version, draft.layout.positions[last!]!.version]).toEqual([2, 2]);
  });

  test("the inspector's position form moves a step by keyboard, and arrow keys on the canvas never save", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await nodeAt(page, middle).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    expect(moves).toHaveLength(0);

    await page.locator(".studio-toolbar").getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Middle/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByLabel("X", { exact: true }).fill("420");
    await page.getByLabel("Y", { exact: true }).fill("-35.5");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(status(page)).toContainText("Positions saved");
    expect((await draftOf(page, projectId)).layout.positions[middle]).toEqual({ x: 420, y: -35.5, version: 2 });
    await page.getByLabel("X", { exact: true }).fill("200000");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Enter numbers from -100000 to 100000.")).toBeVisible();
  });

  test("a move that meets someone else's move keeps my placement until I choose", async ({ page }) => {
    const [, middle, end] = seeded.nodeIds;
    await moveViaApi(page, projectId, seeded, middle!, 900, 900);
    await drag(page, middle!, 150, 0);
    await expect(note(page)).toContainText("Someone moved these steps first");
    const mine = await nodeAt(page, middle!).getAttribute("style");
    await note(page).getByRole("button", { name: "Apply my placement" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(status(page)).toContainText("Positions saved");
    const applied = (await draftOf(page, projectId)).layout.positions[middle!]!;
    expect(applied.version).toBe(3);
    expect(mine).toContain(`translate(${applied.x}px, ${applied.y}px)`);

    await moveViaApi(page, projectId, seeded, end!, 700, 700);
    await drag(page, end!, -120, 0);
    await expect(note(page)).toContainText("Someone moved these steps first");
    await note(page).getByRole("button", { name: "Keep saved positions" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(nodeAt(page, end!)).toHaveAttribute("style", /translate\(700px, 700px\)/);
    expect((await draftOf(page, projectId)).layout.positions[end!]).toEqual({ x: 700, y: 700, version: 2 });
  });

  test("Undo move restores my last move as a new save, and refuses once someone else moved the step", async ({ page }) => {
    const start = seeded.nodeIds[0]!;
    const original = (await draftOf(page, projectId)).layout.positions[start]!;
    await drag(page, start, 200, 0);
    await expect(status(page)).toContainText("Positions saved");
    await status(page).getByRole("button", { name: "Undo move" }).click();
    await expect(status(page).getByRole("button", { name: "Undo move" })).toHaveCount(0);
    expect((await draftOf(page, projectId)).layout.positions[start]).toEqual({ x: original.x, y: original.y, version: 3 });

    await drag(page, start, 200, 0);
    await expect(status(page).getByRole("button", { name: "Undo move" })).toBeVisible();
    await moveViaApi(page, projectId, seeded, start, 50, 50);
    await status(page).getByRole("button", { name: "Undo move" }).click();
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

  test("an arrangement meets a newer move: Apply is refused and a new preview applies", async ({ page }) => {
    await page.locator(".studio-toolbar").getByRole("button", { name: "Arrange" }).click();
    const dialog = page.getByRole("dialog", { name: "Arrange flow" });
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("button", { name: "Apply arrangement" })).toBeVisible();
    await moveViaApi(page, projectId, seeded, seeded.nodeIds[2]!, 640, 640);
    await dialog.getByRole("button", { name: "Apply arrangement" }).click();
    await expect(dialog.getByRole("alert")).toContainText("The flow changed since this preview");
    await dialog.getByRole("button", { name: "Preview" }).click();
    await dialog.getByRole("button", { name: "Apply arrangement" }).click();
    await expect(dialog).toBeHidden();
    expect((await draftOf(page, projectId)).layout.positions[seeded.nodeIds[2]!]).not.toEqual({ x: 640, y: 640, version: 2 });
  });

  test("a pending move locks its steps; an unconfirmed move retries with the same key and saves once", async ({ page }) => {
    const [start, middle] = seeded.nodeIds;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/positions", async (route) => { await held; await route.continue(); });
    await drag(page, middle!, 150, 0);
    await expect(status(page)).toContainText("Position pending");
    await drag(page, middle!, 60, 60); // locked while its save is pending: no second request
    await drag(page, start!, 60, 0); // and nothing else saves while one request is in flight
    expect(moves).toHaveLength(1);
    release();
    await expect(status(page)).toContainText("Positions saved");
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
    await expect(note(page)).toContainText("We couldn’t confirm the new position.");
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(status(page)).toContainText("Positions saved");
    await page.unroute("**/positions");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect((await draftOf(page, projectId)).layout.positions[middle!]!.version).toBe(3);
  });

  test("an in-flight move keeps commands locked and its placement shown after the Studio remounts", async ({ page }) => {
    const middle = seeded.nodeIds[1]!;
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await expect(nodeAt(page, middle)).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const commands: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/commands")) commands.push(request.url()); });
    await page.route("**/positions", async (route) => { await held; await route.continue(); });
    try {
      await drag(page, middle, 150, 0);
      await expect(status(page)).toContainText("Position pending");
      const attempted = await nodeAt(page, middle).getAttribute("style");
      const sidebar = page.locator("#projects-nav");
      await sidebar.getByRole("button", { name: "Other project", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
      await sidebar.getByRole("button", { name: "Positions project", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Positions project" })).toBeVisible();
      await expect(status(page)).toContainText("Position pending");
      await expect(page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true })).toBeDisabled();
      await expect(nodeAt(page, middle)).toHaveAttribute("style", attempted!);
      expect(moves).toHaveLength(1);
      release();
      await expect(status(page)).toContainText("Positions saved");
      await expect(page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true })).toBeEnabled();
      expect(commands).toHaveLength(0);
      expect((await draftOf(page, projectId)).layout.positions[middle]!.version).toBe(2);
    } finally { release(); }
  });
});
