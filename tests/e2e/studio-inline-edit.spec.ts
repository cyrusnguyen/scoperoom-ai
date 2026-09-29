import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, headerSave, openDatabase, saveStudio, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const panel = (page: Page) => page.locator("#right-panel");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const stepEditor = (page: Page, nodeId: string) => nodeAt(page, nodeId).getByRole("textbox", { name: "Step name" });
const edgeEditor = (page: Page) => page.getByRole("textbox", { name: "Connection label" });
const note = (page: Page) => page.locator(".canvas-note");
const saveNote = (page: Page) => page.locator(".save-note");
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
type Batch = { commands: Record<string, unknown>[]; moves: unknown[] };
const batchOf = (request: Request) => request.postDataJSON() as Batch;

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** Start → Pay, plus an unconnected Ship step, created through the real command route. */
async function seed(page: Page, projectId: string) {
  const draftId = (await draftOf(page, projectId)).id;
  const send = async (body: Record<string, unknown>) => {
    const { documentRevision } = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, expectedDocumentRevision: documentRevision, ...body } });
    expect(response.status()).toBe(200);
    return (await response.json() as { createdIds: string[] }).createdIds[0]!;
  };
  const flowId = await send({ command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const node = (kind: string, label: string) => send({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" } });
  const startId = await node("START", "Start");
  const payId = await node("ACTION", "Pay");
  const shipId = await node("ACTION", "Ship");
  const edgeId = await send({ command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" } });
  return { draftId, flowId, startId, payId, shipId, edgeId };
}

/** A client point halfway along an edge's drawn path (always on the path, whatever its routing). */
async function edgePoint(page: Page, edgeId: string) {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`).evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
}

/** Single-command, position and batch writes (Task 14b: the Studio sends only batches, on Save). */
function recordWrites(page: Page) {
  const commands: Request[] = [], positions: Request[] = [], changes: Request[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/commands")) commands.push(request);
    if (request.url().endsWith("/positions")) positions.push(request);
    if (request.url().endsWith("/changes")) changes.push(request);
  });
  return { commands, positions, changes };
}

test.describe("Inline label editing (real draft)", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;
  let ids: Awaited<ReturnType<typeof seed>>;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Inline Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Inline project");
    ids = await seed(page, projectId);
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, ids.payId)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("step labels support pointer and keyboard editing; Save sends one UPDATE_NODE and no move", async ({ page }) => {
    const writes = recordWrites(page);
    const before = await draftOf(page, projectId);
    const pay = nodeAt(page, ids.payId);
    const labelBox = (await pay.locator(".step-label").boundingBox())!;
    const kindBox = (await pay.locator(".step-kind").boundingBox())!;

    await pay.locator(".step-label").dblclick();
    const editor = stepEditor(page, ids.payId);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Pay");
    await expect(editor).toHaveClass(/nodrag/);
    await expect(editor).toHaveClass(/nopan/);
    await expect(editor).toHaveClass(/nowheel/);
    // The editor sits exactly over the label: nothing around it moves.
    const editorBox = (await editor.boundingBox())!;
    for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(editorBox[side] - labelBox[side])).toBeLessThan(1.5);
    const kindAfter = (await pay.locator(".step-kind").boundingBox())!;
    expect(Math.abs(kindAfter.y - kindBox.y)).toBeLessThan(1.5);

    await editor.fill("Pay by card");
    await expect(editor).toHaveValue("Pay by card");
    await editor.press("Enter");
    await expect(editor).toBeHidden();
    await expect(pay.locator(".step-label")).toHaveText("Pay by card");
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    expect(writes.changes).toHaveLength(0);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Pay");

    await saveStudio(page);
    const after = await draftOf(page, projectId);
    expect(after.document.nodes[ids.payId]!.label).toBe("Pay by card");
    expect(after.documentRevision).toBe(before.documentRevision + 1);
    expect(writes.changes).toHaveLength(1);
    expect(batchOf(writes.changes[0]!)).toEqual({ commands: [{ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: before.document.nodes[ids.payId]!.version, payload: { nodeId: ids.payId, label: "Pay by card" }, proposedIds: [] }], moves: [] });
    expect([writes.commands, writes.positions]).toEqual([[], []]);

    // Keyboard entry and focus restoration share this same rename journey.
    await pay.focus();
    await page.keyboard.press("F2");
    await expect(editor).toBeFocused();
    await editor.fill("Pay online");
    await editor.press("Escape");
    await expect(pay).toBeFocused();
    await expect(pay.locator(".step-label")).toHaveText("Pay online");
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Pay online");
  });

  test("Escape applies, unchanged text queues nothing, and composition never commits", async ({ page }) => {
    const writes = recordWrites(page);
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).press("Escape");
    await expect(stepEditor(page, ids.payId)).toBeHidden();
    await expect(headerSave(page)).toBeDisabled();

    await pay.locator(".step-label").dblclick();
    const editor = stepEditor(page, ids.payId);
    await editor.fill("Pay now");
    await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await editor.dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: true });
    await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 }); // WebKit's IME-confirming Enter
    await expect(editor).toBeVisible();
    await expect(headerSave(page)).toBeDisabled();
    await editor.press("Escape");
    await expect(editor).toBeHidden();
    await expect(pay.locator(".step-label")).toHaveText("Pay now");
    await saveStudio(page);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Pay now");
    expect(writes.changes).toHaveLength(1);
  });

  test("an empty or over-limit name is refused locally and the typed text is kept for fixing", async ({ page }) => {
    const writes = recordWrites(page);
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-label").dblclick();
    const editor = stepEditor(page, ids.payId);
    await editor.fill("");
    await expect(editor).toHaveAttribute("placeholder", "Name this step");
    await editor.press("Enter");
    await expect(note(page)).toHaveText("Enter a name. Your text is kept; fix it here or in the inspector.");
    await expect(pay.locator(".step-label")).toHaveText("Pay"); // the canvas shows the step's name, not the refused text

    await pay.locator(".step-label").dblclick();
    await expect(stepEditor(page, ids.payId)).toHaveValue("");
    const long = "x".repeat(161);
    await stepEditor(page, ids.payId).fill(long);
    await page.locator(".studio-flow-title").click(); // blur closes too
    await expect(note(page)).toHaveText("Name can be up to 160 characters (now 161). Your text is kept; fix it here or in the inspector.");
    await pay.locator(".step-kind").dblclick();
    await expect(panel(page).getByLabel("Name")).toHaveValue(long);
    await panel(page).getByRole("button", { name: "Close panel" }).click();
    await pay.locator(".step-label").dblclick();
    await expect(stepEditor(page, ids.payId)).toHaveValue(long);
    await stepEditor(page, ids.payId).press("Escape"); // unchanged since opening: nothing is queued or discarded
    await expect(headerSave(page)).toBeDisabled();

    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).fill("x".repeat(160));
    await stepEditor(page, ids.payId).press("Enter");
    await saveStudio(page);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("x".repeat(160));
    expect(writes.changes).toHaveLength(1);
  });

  test("opening and closing the editor without typing never applies the inspector's unsaved fields", async ({ page }) => {
    const writes = recordWrites(page);
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-kind").dblclick();
    await panel(page).getByLabel("Name").fill("Pay by card");
    await panel(page).getByLabel("Description").fill("Half-written");
    await panel(page).getByRole("button", { name: "Close panel" }).click();

    await pay.locator(".step-label").dblclick();
    await expect(stepEditor(page, ids.payId)).toHaveValue("Pay by card");
    await page.locator(".studio-flow-title").click();
    await expect(stepEditor(page, ids.payId)).toBeHidden();

    // A real inline change with other unsaved fields opens the inspector instead of applying them.
    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).fill("Pay by bank");
    await stepEditor(page, ids.payId).press("Enter");
    await expect(panel(page).getByLabel("Name")).toHaveValue("Pay by bank");
    await expect(panel(page).getByLabel("Description")).toHaveValue("Half-written");
    await expect(headerSave(page)).toBeDisabled(); // nothing was queued
    expect(writes.changes).toHaveLength(0);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Pay");
  });

  test("double-clicking elsewhere on a step opens the inspector, which shares the inline editor's unsaved text", async ({ page }) => {
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-kind").dblclick();
    await expect(stepEditor(page, ids.payId)).toHaveCount(0);
    const name = panel(page).getByLabel("Name");
    await expect(name).toHaveValue("Pay");
    await name.fill("From inspector");
    await panel(page).getByRole("button", { name: "Close panel" }).click();

    await pay.locator(".step-label").dblclick();
    const editor = stepEditor(page, ids.payId);
    await expect(editor).toHaveValue("From inspector");
    await editor.press("End");
    await editor.pressSequentially(" and canvas");
    await editor.press("Enter");
    await saveStudio(page);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("From inspector and canvas");
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(name).toHaveValue("From inspector and canvas");
    await expect(panel(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });

  test("a save that meets someone else's rename keeps the typed name on screen; Apply my changes again saves it", async ({ page }) => {
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).fill("Mine");
    const saved = await draftOf(page, projectId);
    const remote = await page.request.post(`/api/projects/${projectId}/drafts/${ids.draftId}/commands`, { headers: headers(),
      data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: saved.document.nodes[ids.payId]!.version, payload: { nodeId: ids.payId, label: "Theirs" } } });
    expect(remote.status()).toBe(200);
    await stepEditor(page, ids.payId).press("Enter");
    await headerSave(page).click();
    await expect(saveNote(page)).toContainText("Someone else changed this draft first, so your changes weren’t saved.");
    await expect(pay.locator(".step-label")).toHaveText("Mine");
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Theirs");
    // The overlap is shown before anything is sent again (UI02: never resubmit stale text unseen).
    const compared = saveNote(page).locator(".conflict-list");
    await expect(compared).toContainText("Saved valueTheirs");
    await expect(compared).toContainText("Your editMine");
    await expect(compared).toContainText("Before your editPay");
    await saveNote(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    await expect(saveNote(page)).toHaveCount(0);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Mine");
  });

  test("an unconfirmed save keeps its text and retries with the same key; a rename made while a save is in flight saves next", async ({ page }) => {
    const writes = recordWrites(page);
    await page.route("**/changes", (route) => route.abort("failed"), { times: 1 });
    const pay = nodeAt(page, ids.payId);
    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).fill("Pay later");
    await stepEditor(page, ids.payId).press("Enter");
    await headerSave(page).click();
    await expect(saveNote(page)).toContainText("We couldn’t confirm your changes.");
    await expect(pay.locator(".step-label")).toHaveText("Pay later");
    await pay.locator(".step-label").dblclick();
    await expect(stepEditor(page, ids.payId)).toHaveValue("Pay later");
    await stepEditor(page, ids.payId).press("Enter"); // unchanged since opening: nothing new
    expect(writes.changes).toHaveLength(1);
    await saveNote(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe("Pay later");
    expect(writes.changes).toHaveLength(2);
    expect(writes.changes[1]!.headers()["idempotency-key"]).toBe(writes.changes[0]!.headers()["idempotency-key"]);
    expect(writes.changes[1]!.postData()).toBe(writes.changes[0]!.postData());

    // Hold the next save in flight, then rename another step: it queues behind and is sent right after.
    let release: Route | null = null;
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => { held = resolve; });
    await page.route("**/changes", (route) => { release = route; held(); }, { times: 1 });
    await pay.locator(".step-label").dblclick();
    await stepEditor(page, ids.payId).fill("Pay first");
    await stepEditor(page, ids.payId).press("Enter");
    await headerSave(page).click();
    await holding;
    await expect(page.locator(".studio-status")).toContainText("Saving…");
    const ship = nodeAt(page, ids.shipId);
    await ship.locator(".step-label").dblclick();
    await stepEditor(page, ids.shipId).fill("Ship fast");
    await stepEditor(page, ids.shipId).press("Enter");
    await expect(ship.locator(".step-label")).toHaveText("Ship fast");
    await expect(note(page)).toHaveCount(0);
    await release!.continue();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    await expect.poll(() => writes.changes.length).toBe(4);
    expect(writes.changes[3]!.headers()["idempotency-key"]).not.toBe(writes.changes[2]!.headers()["idempotency-key"]);
    const saved = await draftOf(page, projectId);
    expect([saved.document.nodes[ids.payId]!.label, saved.document.nodes[ids.shipId]!.label]).toEqual(["Pay first", "Ship fast"]);
  });

  test("a connection is labelled inline at its label position and cleared again", async ({ page }) => {
    const writes = recordWrites(page);
    const point = await edgePoint(page, ids.edgeId);
    await page.mouse.click(point.x, point.y);
    const hint = page.locator(".edge-label-hint");
    await expect(hint).toHaveText("Add label");
    const hintBox = (await hint.boundingBox())!;

    await page.mouse.dblclick(point.x, point.y);
    const input = edgeEditor(page);
    await expect(input).toBeFocused();
    await expect(input).toHaveClass(/nodrag/);
    await expect(input).toHaveClass(/nopan/);
    const pill = page.locator(".edge-label-editor");
    const pillBox = (await pill.boundingBox())!;
    expect(Math.abs((pillBox.x + pillBox.width / 2) - (hintBox.x + hintBox.width / 2))).toBeLessThan(1.5);
    expect(Math.abs((pillBox.y + pillBox.height / 2) - (hintBox.y + hintBox.height / 2))).toBeLessThan(1.5);
    await input.fill("Card accepted by the processor");
    expect((await pill.boundingBox())!.width).toBeGreaterThan(pillBox.width); // grows with its text
    await input.press("Enter");
    await expect(input).toBeHidden();
    await expect(page.locator(".edge-label").filter({ hasText: "Card accepted by the processor" })).toBeVisible();
    await saveStudio(page);
    expect((await draftOf(page, projectId)).document.edges[ids.edgeId]!.condition).toBe("Card accepted by the processor");

    await page.mouse.dblclick(point.x, point.y);
    await expect(edgeEditor(page)).toHaveValue("Card accepted by the processor");
    await edgeEditor(page).fill("");
    await edgeEditor(page).press("Escape");
    await saveStudio(page);
    expect((await draftOf(page, projectId)).document.edges[ids.edgeId]!.condition).toBe("");
    expect(writes.changes.map((request) => batchOf(request).commands.map((command) => command.command))).toEqual([["UPDATE_EDGE"], ["UPDATE_EDGE"]]);
    expect(writes.changes.every((request) => batchOf(request).moves.length === 0)).toBe(true);
  });
});

test.describe("Inline label editing (read-only, mocked project)", () => {
  const projectId = "c3333333-3333-4333-8333-333333333333";
  const flowId = "d3333333-3333-4333-8333-333333333333";
  const startId = "e4444444-4444-4444-8444-444444444444";
  const endId = "e5555555-5555-4555-8555-555555555555";
  const edgeId = "e6666666-6666-4666-8666-666666666666";

  test("a reader cannot open either editor", async ({ page }) => {
    const admin = adminClient();
    const database = await openDatabase();
    const users: string[] = [];
    try {
      await signIn(page, admin, users, "Inline Reader");
      const view = emptyDraftView();
      const step = (id: string, kind: "START" | "OUTCOME", label: string) => ({ id, flowId, version: 1, behaviourVersion: 1, kind, label, description: "", actorLabel: "", origin: "HUMAN" as const, sourceRefs: [] as [], assumptionNotes: [] });
      const draft: DraftView = {
        ...view,
        document: {
          ...view.document,
          flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: "Intake", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null } },
          nodes: { [startId]: step(startId, "START", "Receive form"), [endId]: step(endId, "OUTCOME", "Filed") },
          edges: { [edgeId]: { id: edgeId, flowId, version: 1, fromId: startId, toId: endId, condition: "", origin: "HUMAN", sourceRefs: [] } },
        },
        layout: { schemaVersion: 1, positions: { [startId]: { x: 0, y: 0, version: 1 }, [endId]: { x: 0, y: 240, version: 1 } }, directions: { [flowId]: "TB" }, edgeSides: {} },
      };
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [], truncated: false }, shared: { items: [{ id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" }], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } } }));
      await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
      await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerId: projectId }, draft } }));
      await page.goto(`/app/projects/${projectId}`);
      await expect(nodeAt(page, startId)).toBeVisible();

      await nodeAt(page, startId).locator(".step-label").dblclick();
      await expect(panel(page).getByRole("heading", { name: "Start" })).toBeVisible(); // the inspector, read-only
      await expect(page.getByRole("textbox", { name: "Step name" })).toHaveCount(0);
      await panel(page).getByRole("button", { name: "Close panel" }).click();
      await nodeAt(page, startId).focus();
      await page.keyboard.press("F2");
      await expect(page.getByRole("textbox", { name: "Step name" })).toHaveCount(0);
      const point = await edgePoint(page, edgeId);
      await page.mouse.dblclick(point.x, point.y);
      await expect(edgeEditor(page)).toHaveCount(0);
      await expect(page.locator(".edge-label-hint")).toHaveCount(0);
    } finally {
      try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
    }
  });
});
