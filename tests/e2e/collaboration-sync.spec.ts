import { randomUUID } from "node:crypto";
import { expect, type APIResponse, type Page, type Route } from "@playwright/test";
import { test } from "./collaboration-fixtures";
import { statusDelay } from "../../src/features/collaboration/ui/project-sync.ts";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.2 Task 6: two real users, no Realtime and no mocked collaborator. The owner acts through their own browser (or the
// real API as that account); the editor's page has a fake clock, so one `runFor` of the longest healthy poll delay is a
// deterministic deadline: statusDelay's maximum (10 s +10%), never a bare sleep. Route interception only orders responses.
const POLL_DEADLINE = statusDelay(0, 1);
const status = (page: Page) => page.locator(".studio-status");
const notice = (page: Page) => page.locator(".save-note");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const quiet = (page: Page) => page.waitForTimeout(500); // a bounded window in which a premature write would already have shown
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const envelope = (code: string, message: string) => ({ error: { code, message, requestId: "00000000-0000-4000-8000-000000000000", retryable: true } });
const FROZEN = "Newer saved changes are available";
const STALE = "Someone else changed this draft first";

type Ids = { flowId: string; draftId: string; startId: string; payId: string; shipId: string };

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** Start -> Pay, plus a lone Ship step, created by the owner in one real batch. */
async function seed(page: Page, projectId: string): Promise<Ids> {
  const [flowId, startId, payId, shipId] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  const node = (id: string, kind: string, label: string) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [id] });
  const draftId = await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Collab", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    node(startId, "START", "Start"), node(payId, "ACTION", "Pay"), node(shipId, "ACTION", "Ship"),
    { command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" }, proposedIds: [randomUUID()] },
  ]);
  return { flowId, draftId, startId, payId, shipId };
}

/** A saved rename by the given account, through the real API at the record's current version. */
async function rename(page: Page, projectId: string, nodeId: string, label: string) {
  const draft = await draftOf(page, projectId);
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
    headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: draft.document.nodes[nodeId]!.version, payload: { nodeId, label } },
  });
  expect(response.status()).toBe(200);
}
async function moveTo(page: Page, projectId: string, ids: Ids, nodeId: string, x: number, y: number) {
  const { positions } = (await draftOf(page, projectId)).layout;
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${ids.draftId}/positions`, {
    headers: headers(), data: { mode: "MOVE_NODES", flowId: ids.flowId, items: [{ nodeId, expectedPositionVersion: positions[nodeId]!.version, x, y }] },
  });
  expect(response.status()).toBe(200);
}

/**
 * Runs the editor's frozen clock in short slices until its next status read starts, at most the longest healthy poll delay.
 * Slicing stops the clock right there: a dirty edit's 10 s autosave (a timer on the same clock) never gets to send before
 * the poll it is meant to meet. The editor page pins its jitter to the minimum (see openBoth), so the poll is due after 9 s.
 */
async function poll(page: Page) {
  let started = 0;
  const count = (request: { url(): string }) => { if (/\/status$/.test(new URL(request.url()).pathname)) started++; };
  const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
  page.on("request", count);
  try {
    for (let waited = 0; !started && waited < POLL_DEADLINE; waited += 250) {
      await page.clock.runFor(250);
      await new Promise((resolve) => setTimeout(resolve, 25)); // let the page's request event reach this process
    }
  } finally { page.off("request", count); }
  expect(started, "a status read within the longest poll delay").toBeGreaterThan(0);
  await answered;
}
async function renameLocally(page: Page, nodeId: string, label: string) {
  await nodeAt(page, nodeId).locator(".step-label").dblclick();
  await nodeAt(page, nodeId).getByRole("textbox", { name: "Step name" }).fill(label);
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Unsaved changes");
}
async function drag(page: Page, nodeId: string, dx: number, dy: number) {
  const box = (await nodeAt(page, nodeId).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}
async function connect(page: Page, fromId: string, toId: string) {
  await nodeAt(page, fromId).locator('.react-flow__handle[data-handleid="bottom"]').first().dragTo(nodeAt(page, toId).locator('.react-flow__handle[data-handleid="top"]').first());
}
/** Every mutation this page sends to the draft API. */
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && /\/drafts\/[^/]+\/(changes|positions|commands)$/.test(request.url())) writes.push(request.url()); });
  return writes;
}
/** Reads of D are fetched at once but delivered when the test says so. */
async function holdDraftReads(page: Page, projectId: string) {
  const held: { route: Route; response: APIResponse }[] = [];
  await page.route(`**/api/projects/${projectId}/drafts/*`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    held.push({ route, response: await route.fetch() });
  });
  return { held, deliver: (index: number) => held[index]!.route.fulfill({ response: held[index]!.response }) };
}

test.describe("two real users converge through status polling", () => {
  let ids: Ids;
  test.beforeEach(async ({ collaboration: { ownerPage, projectId } }) => {
    test.setTimeout(120_000);
    ids = await seed(ownerPage, projectId);
  });

  async function openBoth({ ownerPage, editorPage, projectId }: { ownerPage: Page; editorPage: Page; projectId: string }) {
    await editorPage.addInitScript(() => { Math.random = () => 0; }); // jitter 0: the poll is due exactly 9 s after the last read
    await editorPage.clock.install();
    for (const page of [ownerPage, editorPage]) {
      await page.goto(`/app/projects/${projectId}`);
      await expect(nodeAt(page, ids.payId)).toBeVisible();
    }
    await editorPage.clock.pauseAt(new Date(Date.now() + 2_000)); // from here only `poll` and `runFor` move the editor's time
  }

  test("another person's label, topology and position saves appear within one poll deadline", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    await expect(editorPage.locator(".react-flow__edge")).toHaveCount(1);

    // The owner renames Ship, connects Pay -> Ship and moves Start in their own Studio, then saves once.
    await renameLocally(ownerPage, ids.shipId, "Ship (owner)");
    await connect(ownerPage, ids.payId, ids.shipId);
    await drag(ownerPage, ids.startId, 200, 0);
    await headerSave(ownerPage).click();
    await expect(status(ownerPage)).toContainText("All changes saved");
    const saved = await draftOf(ownerPage, projectId);
    const start = saved.layout.positions[ids.startId]!;
    expect(start.version).toBe(2);

    await expect(nodeAt(editorPage, ids.shipId)).not.toContainText("Ship (owner)"); // nothing arrives before the poll
    await poll(editorPage);
    await expect(nodeAt(editorPage, ids.shipId)).toContainText("Ship (owner)");
    await expect(editorPage.locator(".react-flow__edge")).toHaveCount(2);
    await expect(nodeAt(editorPage, ids.startId)).toHaveAttribute("style", new RegExp(`translate\\(${start.x}px, ${start.y}px\\)`));
    await expect(status(editorPage)).not.toContainText("Unsaved changes");
    await expect(notice(editorPage)).toHaveCount(0);
  });

  test("a dirty local edit and an unrelated remote edit are both shown after the poll, and both survive the save", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    await renameLocally(editorPage, ids.startId, "Start (mine)");
    await rename(ownerPage, projectId, ids.shipId, "Ship (theirs)");
    await poll(editorPage);
    await expect(nodeAt(editorPage, ids.shipId)).toContainText("Ship (theirs)");
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Start (mine)");
    await expect(notice(editorPage)).toHaveCount(0);
    await expect(status(editorPage)).toContainText("Unsaved changes");

    await headerSave(editorPage).click();
    await expect(status(editorPage)).toContainText("All changes saved");
    const { nodes } = (await draftOf(ownerPage, projectId)).document;
    expect([nodes[ids.startId]!.label, nodes[ids.shipId]!.label]).toEqual(["Start (mine)", "Ship (theirs)"]);
  });

  test("a remote edit of the same record keeps the frozen view with one notice, and Save resolves through the refused-save review", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    await renameLocally(editorPage, ids.startId, "Mine");
    await rename(ownerPage, projectId, ids.startId, "Theirs");
    await poll(editorPage);
    await expect(notice(editorPage)).toHaveCount(1);
    await expect(notice(editorPage)).toContainText(FROZEN);
    await expect(notice(editorPage)).toContainText("Theirs");
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Mine");

    await notice(editorPage).getByRole("button", { name: "Save", exact: true }).click();
    await expect(notice(editorPage)).toHaveCount(1);
    await expect(notice(editorPage)).toContainText(STALE);
    expect((await draftOf(ownerPage, projectId)).document.nodes[ids.startId]!.label).toBe("Theirs"); // refused: nothing overwritten
    await notice(editorPage).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(status(editorPage)).toContainText("All changes saved");
    await expect(notice(editorPage)).toHaveCount(0);
    expect((await draftOf(ownerPage, projectId)).document.nodes[ids.startId]!.label).toBe("Mine");
  });

  test("an unsaved undo after someone else's saved move is refused with POSITION_CONFLICT and overwrites nothing", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    await drag(editorPage, ids.startId, 200, 0);
    await drag(editorPage, ids.startId, 0, 120);
    await moveTo(ownerPage, projectId, ids, ids.startId, 640, 480);
    await poll(editorPage);
    await expect(notice(editorPage)).toContainText(FROZEN);

    await status(editorPage).getByRole("button", { name: "Undo" }).click(); // edits only the outbox: the first drop remains, still guarded by v1
    const refused = editorPage.waitForResponse((response) => /\/changes$/.test(response.url()) && response.request().method() === "POST");
    await headerSave(editorPage).click();
    const response = await refused;
    expect(response.status()).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("POSITION_CONFLICT");
    await expect(notice(editorPage)).toContainText(STALE);
    const start = (await draftOf(ownerPage, projectId)).layout.positions[ids.startId]!;
    expect(start).toMatchObject({ x: 640, y: 480, version: 2 });
  });

  test("a read that started before my save and lands after its receipt cannot hide the saved edit; the covering read then completes", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    const reads = await holdDraftReads(editorPage, projectId);
    await rename(ownerPage, projectId, ids.shipId, "Ship (theirs)");
    await poll(editorPage);
    await expect.poll(() => reads.held.length).toBe(1); // read R1: has their rename, not my edit
    await renameLocally(editorPage, ids.startId, "Mine");
    await headerSave(editorPage).click();
    await expect.poll(() => reads.held.length).toBe(2); // read R2, after my receipt: covers it
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Mine");

    await reads.deliver(0); // R1 lands below the acknowledged floor: dropped
    await quiet(editorPage);
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Mine");
    await expect(nodeAt(editorPage, ids.shipId)).not.toContainText("Ship (theirs)");
    await expect(status(editorPage)).not.toContainText("All changes saved");
    await reads.deliver(1);
    await expect(status(editorPage)).toContainText("All changes saved");
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Mine");
    await expect(nodeAt(editorPage, ids.shipId)).toContainText("Ship (theirs)");
  });

  test("an unavailable API shows Not saved and keeps the edit; a later Save shows their save and sends both", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    await openBoth(collaboration);
    const writes = watchWrites(editorPage);
    let failing = true;
    await editorPage.route(/\/status$/, (route) => (failing ? route.fulfill({ status: 503, json: envelope("UNAVAILABLE", "Try again.") }) : route.continue()));
    await renameLocally(editorPage, ids.startId, "Mine");
    await rename(ownerPage, projectId, ids.shipId, "Ship (theirs)");
    await editorPage.evaluate(() => { window.dispatchEvent(new Event("focus")); }); // authority must be proven again before a write
    await headerSave(editorPage).click();
    await expect(status(editorPage)).toContainText("Not saved");
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Mine"); // the edit is still there
    expect(writes).toHaveLength(0);

    failing = false;
    await headerSave(editorPage).click();
    await expect(status(editorPage)).toContainText("All changes saved");
    await expect(nodeAt(editorPage, ids.shipId)).toContainText("Ship (theirs)");
    const { nodes } = (await draftOf(ownerPage, projectId)).document;
    expect([nodes[ids.startId]!.label, nodes[ids.shipId]!.label]).toEqual(["Mine", "Ship (theirs)"]);
  });

  test("the editor's page becomes read-only with copy and discard after a downgrade, and sends nothing more", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId, setEditorRole } = collaboration;
    await openBoth(collaboration);
    const writes = watchWrites(editorPage);
    await renameLocally(editorPage, ids.startId, "Mine");
    await setEditorRole("VIEWER");
    await poll(editorPage);
    await expect(notice(editorPage)).toContainText("This draft is read-only now, so your unsaved changes can’t be saved");
    await expect(notice(editorPage)).toContainText("Mine");
    await expect(notice(editorPage).getByRole("button", { name: "Discard my changes" })).toBeVisible();
    await editorPage.clock.runFor(POLL_DEADLINE + 10_000); // autosave and another poll: still nothing
    await quiet(editorPage);
    expect(writes).toHaveLength(0);
    // The backend refuses too, independent of the page.
    const attempt = await editorPage.request.post(`/api/projects/${projectId}/drafts/${ids.draftId}/commands`, {
      headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: ids.startId, label: "Sneaky" } },
    });
    expect(attempt.status()).toBe(403);
    expect((await draftOf(ownerPage, projectId)).document.nodes[ids.startId]!.label).toBe("Start");

    await notice(editorPage).getByRole("button", { name: "Discard my changes" }).click();
    await expect(notice(editorPage)).toHaveCount(0);
    await expect(status(editorPage)).not.toContainText("Unsaved changes");
  });

  test("removal while the page is open tears the project down, with nothing sent and the backend denying", async ({ collaboration }) => {
    const { editorPage, projectId, removeEditor } = collaboration;
    await openBoth(collaboration);
    const writes = watchWrites(editorPage);
    await renameLocally(editorPage, ids.startId, "Mine");
    await removeEditor();
    await poll(editorPage);
    await expect(editorPage.getByRole("heading", { level: 1, name: "Project unavailable" })).toBeVisible();
    await expect(editorPage.getByText("Unsaved changes")).toHaveCount(0);
    await expect(editorPage.getByText("Mine")).toHaveCount(0);
    await editorPage.clock.runFor(POLL_DEADLINE + 10_000);
    await quiet(editorPage);
    expect(writes).toHaveLength(0);
    expect((await editorPage.request.get(`/api/projects/${projectId}/bootstrap`)).status()).toBe(404);
    const attempt = await editorPage.request.post(`/api/projects/${projectId}/drafts/${ids.draftId}/commands`, {
      headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: ids.startId, label: "Sneaky" } },
    });
    expect(attempt.status()).toBe(404);
  });

  test("a tab that was hidden while access was removed sends nothing on return until status answers, then nothing at all", async ({ collaboration }) => {
    const { editorPage, removeEditor } = collaboration;
    await openBoth(collaboration);
    const writes = watchWrites(editorPage);
    await renameLocally(editorPage, ids.startId, "Mine");
    const setVisibility = (state: "hidden" | "visible") => editorPage.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
    await setVisibility("hidden");
    await removeEditor(); // while nobody was looking
    const statusReads: Route[] = [];
    await editorPage.route(/\/status$/, (route) => { statusReads.push(route); });
    await editorPage.clock.runFor(POLL_DEADLINE); // hidden: the poll is paused and autosave cannot beat the barrier
    await quiet(editorPage);
    expect(writes).toHaveLength(0);
    await setVisibility("visible");
    await expect.poll(() => statusReads.length).toBeGreaterThan(0);
    await editorPage.keyboard.press("Control+s");
    await quiet(editorPage);
    expect(writes).toHaveLength(0); // the return's status read has not answered yet
    for (const route of statusReads.splice(0)) await route.continue();
    await expect(editorPage.getByRole("heading", { level: 1, name: "Project unavailable" })).toBeVisible();
    await quiet(editorPage);
    expect(writes).toHaveLength(0);
  });

  test("project switch A to B to A with a delayed A read: the stale response cannot regress the reopened A", async ({ collaboration }) => {
    const { ownerPage, editorPage, projectId } = collaboration;
    const otherId = await createProjectViaApi(editorPage, "Editor's own project");
    await openBoth(collaboration);
    const reads = await holdDraftReads(editorPage, projectId);
    await rename(ownerPage, projectId, ids.startId, "Theirs 1");
    await poll(editorPage);
    await expect.poll(() => reads.held.length).toBe(1); // D read of A at "Theirs 1", delivered late
    await rename(ownerPage, projectId, ids.startId, "Theirs 2");

    await editorPage.clock.resume(); // the router's own timers need real time to navigate
    const nav = editorPage.locator("#projects-nav");
    await nav.getByRole("tab", { name: "Owned projects" }).click();
    await nav.getByRole("button", { name: "Editor's own project", exact: true }).click();
    await expect(editorPage.getByRole("heading", { level: 1, name: "Editor's own project" })).toBeVisible();
    await nav.getByRole("tab", { name: "Shared with me" }).click();
    await nav.getByRole("button", { name: /^Collaboration project/ }).click();
    await expect(editorPage.getByRole("heading", { level: 1, name: "Collaboration project" })).toBeVisible();
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Theirs 2");
    expect(editorPage.url()).not.toContain(otherId);

    await reads.deliver(0); // the old controller's answer arrives after the round trip
    await quiet(editorPage);
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Theirs 2");
    // The reopened A has its own live controller.
    await editorPage.unroute(`**/api/projects/${projectId}/drafts/*`);
    for (let index = 1; index < reads.held.length; index++) await reads.deliver(index); // nothing may stay pending
    await rename(ownerPage, projectId, ids.startId, "Theirs 3");
    await poll(editorPage);
    await expect(nodeAt(editorPage, ids.startId)).toContainText("Theirs 3");
  });
});
