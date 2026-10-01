import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { interceptRealtime } from "./collaboration-fixtures";
import { test } from "./studio-fixtures";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.2 Task 3: what the Studio says while a saved read waits behind the person's unsaved changes (frozen), when a
// saved read cleared their redo history, when typed inspector text meets a newer record, and while a read is not landing.
// "Someone else" is the same account through the API: the page never saw those receipts, exactly like another user.
const status = (page: Page) => page.locator(".studio-status");
const notice = (page: Page) => page.locator(".save-note");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const stepEditor = (page: Page, nodeId: string) => nodeAt(page, nodeId).getByRole("textbox", { name: "Step name" });
const FROZEN = "Newer saved changes are available";
const REDO_CLEARED = "Saved updates loaded. Redo history was cleared.";

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** Start, Pay and Ship steps with a Start -> Pay connection, created in one real batch. */
async function seed(page: Page, projectId: string) {
  const [flowId, startId, payId, shipId, edgeId] = Array.from({ length: 5 }, () => randomUUID());
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Notices", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId!] },
    ...[[startId, "START", "Start"], [payId, "ACTION", "Pay"], [shipId, "ACTION", "Ship"]].map(([id, kind, label]) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [id!] })),
    { command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" }, proposedIds: [edgeId!] },
  ]);
  return { flowId: flowId!, startId: startId!, payId: payId!, shipId: shipId!, edgeId: edgeId! };
}

/** Another user's saved rename, at the record's current version. */
async function renameElsewhere(page: Page, projectId: string, nodeId: string, label: string) {
  const draft = await draftOf(page, projectId);
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: draft.document.nodes[nodeId]!.version, payload: { nodeId, label } },
  });
  expect(response.status()).toBe(200);
}

/** A status read right now (window focus), without moving the fake clock: pending autosave timers stay put. */
async function revalidate(page: Page) {
  const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await answered;
}
async function poll(page: Page, ms = 11_000) {
  const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
  await page.clock.runFor(ms);
  await answered;
}

/** A local, unsaved rename on the canvas. */
async function renameLocally(page: Page, nodeId: string, label: string) {
  await nodeAt(page, nodeId).locator(".step-label").dblclick();
  await stepEditor(page, nodeId).fill(label);
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Unsaved changes");
}

test.describe("Frozen view, redo history, typed text and refreshing", () => {
  let projectId: string;
  let ids: Awaited<ReturnType<typeof seed>>;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    projectId = await createProjectViaApi(page, "Notices project");
    ids = await seed(page, projectId);
    await page.clock.install();
  });
  const open = async (page: Page, narrow = false) => {
    // The Realtime join (Stage 04.3) reads status once: let it settle, so a later step counts only its own reads (two failed saved reads give up).
    const joined = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
    await page.goto(`/app/projects/${projectId}`);
    // At 390 px the Studio opens on the List; the canvas is not mounted.
    await expect(narrow ? page.locator(".studio-toolbar") : nodeAt(page, ids.payId)).toBeVisible();
    await joined;
  };

  test("a remote edit of what I changed freezes the view with one notice; Keep theirs resolves it", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.startId, "Mine");
    await renameElsewhere(page, projectId, ids.startId, "Theirs");
    await revalidate(page);

    await expect(notice(page)).toHaveCount(1);
    await expect(notice(page)).toContainText(FROZEN);
    await expect(notice(page)).toHaveAttribute("role", "status");
    // What is compared: their value, mine, and the value before my edit. The view itself stays on my change.
    await expect(notice(page)).toContainText("Saved value");
    await expect(notice(page)).toContainText("Theirs");
    await expect(notice(page)).toContainText("Your edit");
    await expect(notice(page)).toContainText("Mine");
    await expect(nodeAt(page, ids.startId)).toContainText("Mine");
    await expect(notice(page).getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    await notice(page).getByRole("button", { name: "Keep theirs" }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(nodeAt(page, ids.startId)).toContainText("Theirs");
    await expect(status(page)).not.toContainText("Unsaved changes");
  });

  test("the notice's Save meets the refused-save review, and Apply my changes again resolves it", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.startId, "Mine");
    await renameElsewhere(page, projectId, ids.startId, "Theirs");
    await revalidate(page);
    await expect(notice(page)).toContainText(FROZEN);

    await notice(page).getByRole("button", { name: "Save", exact: true }).click();
    // Still one notice: the refused-save review carries the same headline and its own actions.
    await expect(notice(page)).toHaveCount(1);
    await expect(notice(page)).toContainText(FROZEN);
    await expect(notice(page)).toContainText("Someone else changed this draft first");
    await expect(notice(page).getByRole("button", { name: "Apply my changes again" })).toBeEnabled();
    await notice(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(status(page)).toContainText("All changes saved");
    await expect(notice(page)).toHaveCount(0);
    expect((await draftOf(page, projectId)).document.nodes[ids.startId]!.label).toBe("Mine");
  });

  /** Two local renames (Ship, then Start) and two remote ones (Start, Pay) in one adopted read: only Start conflicts. */
  async function freezeOnStart(page: Page) {
    await open(page);
    await renameLocally(page, ids.shipId, "Ship mine");
    await renameLocally(page, ids.startId, "Mine");
    await renameElsewhere(page, projectId, ids.startId, "Theirs");
    await renameElsewhere(page, projectId, ids.payId, "Pay (theirs)");
    await revalidate(page);
    await expect(notice(page)).toContainText(FROZEN);
    await expect(nodeAt(page, ids.startId)).toContainText("Mine");
    await expect(nodeAt(page, ids.payId)).not.toContainText("Pay (theirs)"); // hidden behind the frozen view
  }

  test("Keep theirs on the only conflicting change of several moves the view to the newer draft and clears the notice with it", async ({ page }) => {
    await freezeOnStart(page);
    await notice(page).getByRole("button", { name: "Keep theirs" }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(nodeAt(page, ids.startId)).toContainText("Theirs");
    await expect(nodeAt(page, ids.payId)).toContainText("Pay (theirs)");
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship mine");
    await expect(status(page)).toContainText("Unsaved changes");
  });

  test("undoing the only conflicting change of several moves the view to the newer draft and clears the notice with it", async ({ page }) => {
    await freezeOnStart(page);
    await status(page).getByRole("button", { name: "Undo" }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(nodeAt(page, ids.startId)).toContainText("Theirs");
    await expect(nodeAt(page, ids.payId)).toContainText("Pay (theirs)");
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship mine");
    await expect(status(page)).toContainText("Unsaved changes");
  });

  test("below the acknowledged floor no comparison is shown: a refused save after a failed re-read lists no Saved value", async ({ page }) => {
    await open(page);
    let failing = true;
    await page.route(`**/api/projects/${projectId}/drafts/*`, (route) => (failing && route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } }) : route.continue()));
    await renameLocally(page, ids.startId, "Acknowledged");
    await headerSave(page).click();
    await expect(status(page)).toContainText("Refreshing saved changes");
    await renameElsewhere(page, projectId, ids.startId, "Theirs");
    await renameLocally(page, ids.startId, "Mine again");
    await headerSave(page).click();

    await expect(notice(page)).toContainText("Someone else changed this draft first");
    // The saved draft shown is older than my own acknowledged save, so its "Saved value" would be my own earlier text.
    await expect(notice(page)).not.toContainText("Saved value");
    await expect(notice(page).getByRole("button", { name: "Keep theirs" })).toHaveCount(0);
    await expect(notice(page).getByRole("button", { name: "Apply my changes again" })).toBeDisabled();

    failing = false;
    await status(page).getByRole("button", { name: "Retry", exact: true }).click();
    await expect(notice(page)).toContainText("Saved value");
    await expect(notice(page)).toContainText("Theirs");
    await expect(notice(page).getByRole("button", { name: "Keep theirs" })).toBeEnabled();
    await expect(notice(page).getByRole("button", { name: "Apply my changes again" })).toBeEnabled();
  });

  test("a remote change to another record is shown at once, with no notice", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.startId, "Mine");
    await renameElsewhere(page, projectId, ids.shipId, "Ship (theirs)");
    await revalidate(page);
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship (theirs)");
    await expect(nodeAt(page, ids.startId)).toContainText("Mine");
    await expect(notice(page)).toHaveCount(0);
  });

  test("a deleted target still gets the general notice, without comparison rows", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.payId, "Pay (mine)");
    const draft = await draftOf(page, projectId);
    const response = await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: draft.documentRevision, payload: { flowId: ids.flowId, nodeIds: [ids.payId], removeEdgeIds: [ids.edgeId] } },
    });
    expect(response.status()).toBe(200);
    await revalidate(page);
    await expect(notice(page)).toContainText(FROZEN);
    await expect(notice(page)).not.toContainText("Saved value");
    await expect(notice(page).getByRole("button", { name: "Save", exact: true })).toBeVisible();
  });

  test("everything undone after a conflicting read: the fresh draft shows, Redo is gone, and one message explains it", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.startId, "Mine");
    await renameElsewhere(page, projectId, ids.startId, "Theirs");
    await revalidate(page);
    await expect(notice(page)).toContainText(FROZEN);
    await expect(status(page).getByRole("button", { name: "Redo" })).toHaveCount(0);

    await status(page).getByRole("button", { name: "Undo" }).click();
    await expect(nodeAt(page, ids.startId)).toContainText("Theirs");
    await expect(notice(page)).toHaveCount(0);
    await expect(status(page).getByRole("button", { name: "Redo" })).toHaveCount(0);
    const message = status(page).getByText(REDO_CLEARED);
    await expect(message).toHaveCount(1);
    await expect(message).toHaveAttribute("role", "status");

    // Repeated polls (with and without further saved changes) never announce it again, and a dismissal sticks.
    await renameElsewhere(page, projectId, ids.shipId, "Ship (theirs)");
    await poll(page);
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship (theirs)");
    await poll(page);
    await expect(status(page).getByText(REDO_CLEARED)).toHaveCount(1);
    await status(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(status(page).getByText(REDO_CLEARED)).toHaveCount(0);
    await renameElsewhere(page, projectId, ids.shipId, "Ship (again)");
    await poll(page);
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship (again)");
    await expect(status(page).getByText(REDO_CLEARED)).toHaveCount(0);
  });

  test("a compatible redo survives a read and nothing is announced", async ({ page }) => {
    await open(page);
    await renameLocally(page, ids.startId, "Mine");
    await status(page).getByRole("button", { name: "Undo" }).click();
    await renameElsewhere(page, projectId, ids.shipId, "Ship (theirs)");
    await poll(page);
    await expect(nodeAt(page, ids.shipId)).toContainText("Ship (theirs)");
    await expect(status(page).getByRole("button", { name: "Redo" })).toBeVisible();
    await expect(status(page).getByText(REDO_CLEARED)).toHaveCount(0);
  });

  test("typed inspector text keeps its exact text beside 'Changed by someone else'; Save my edit applies it", async ({ page }) => {
    await open(page);
    await nodeAt(page, ids.payId).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const field = panel.getByLabel("Name", { exact: true });
    const typed = "  Mine, with   spaces	and a tab ";
    await field.fill(typed);
    await renameElsewhere(page, projectId, ids.payId, "Pay (theirs)");
    await revalidate(page);

    await expect(panel.getByText("Changed by someone else")).toBeVisible();
    await expect(panel.getByText("Pay (theirs)")).toBeVisible(); // their saved value, compared with my text
    await expect(field).toHaveValue(typed);
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    // Keyboard: the actions are reachable in order and Enter activates one.
    await panel.getByRole("button", { name: "Save my edit" }).focus();
    await expect(panel.getByRole("button", { name: "Save my edit" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("All changes saved");
    await expect(panel.getByText("Changed by someone else")).toHaveCount(0);
    expect((await draftOf(page, projectId)).document.nodes[ids.payId]!.label).toBe(typed);
  });

  test("Keep saved value drops the typed text and shows the newer record", async ({ page }) => {
    await open(page);
    await nodeAt(page, ids.payId).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const field = panel.getByLabel("Name", { exact: true });
    await field.fill("Mine");
    await renameElsewhere(page, projectId, ids.payId, "Pay (theirs)");
    await revalidate(page);
    await expect(panel.getByText("Changed by someone else")).toBeVisible();
    await panel.getByRole("button", { name: "Keep saved value" }).click();
    await expect(field).toHaveValue("Pay (theirs)");
    await expect(panel.getByText("Changed by someone else")).toHaveCount(0);
  });

  test("a read that does not land says 'Refreshing saved changes…' once, then offers Retry at the poll's backoff cap", async ({ page }) => {
    // The poll supplies the second failed read here; a save's hint can legitimately reach recovery before that poll.
    (await interceptRealtime(page)).dropEvents = true;
    await open(page);
    let failing = true;
    await page.route(`**/api/projects/${projectId}/drafts/*`, (route) => (failing && route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } }) : route.continue()));
    await renameLocally(page, ids.startId, "Saved title");
    await headerSave(page).click();

    const line = status(page).locator('[role="status"]').filter({ hasText: /saved changes/ });
    await expect(line).toHaveText("Changes saved. Refreshing saved changes…");
    await expect(status(page).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(nodeAt(page, ids.startId)).toContainText("Saved title"); // the acknowledged edit stays shown
    await expect(status(page)).not.toContainText("All changes saved");

    await poll(page); // the poll sees the newer revision, and its read fails as well
    await expect(line).toHaveText("Changes saved. Couldn't refresh saved changes");
    const retry = status(page).getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    // Polls while it is failing keep the same line: no new announcement per poll.
    await poll(page, 31_000);
    await expect(line).toHaveCount(1);
    await expect(line).toHaveText("Changes saved. Couldn't refresh saved changes");

    failing = false;
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("All changes saved");
    await expect(retry).toHaveCount(0);
    await expect(nodeAt(page, ids.startId)).toContainText("Saved title");
  });

  test("at 390 px with reduced motion the notice fits, its actions are touch-sized and nothing animates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, true);
    await page.getByRole("button", { name: /^Delete connection/ }).click();
    await renameElsewhere(page, projectId, ids.shipId, "Ship (theirs)"); // a document change: the queued delete's guard is stale
    await revalidate(page);

    await expect(notice(page)).toContainText(FROZEN);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const box = (await notice(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const save = notice(page).getByRole("button", { name: "Save", exact: true });
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await notice(page).evaluate((element) => [element, ...element.querySelectorAll("*")].every((node) => {
      const style = getComputedStyle(node);
      return style.animationName === "none" && (parseFloat(style.transitionDuration) || 0) === 0 && node.getAnimations().length === 0;
    }))).toBe(true);
    // Keyboard: Save is reachable and Enter runs it; the guard is stale, so the refused-save review takes over (still one notice).
    await save.focus();
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(notice(page)).toContainText("Someone else changed this draft first");
    await expect(notice(page)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
