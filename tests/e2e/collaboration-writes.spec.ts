import { randomUUID } from "node:crypto";
import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./studio-fixtures";
import { createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.2 Task 5: no mutation goes out before the status controller has revalidated authority. Status is paused by
// route interception (the real server answers once it is released), and every save trigger is fired while it is held.
const status = (page: Page) => page.locator(".studio-status");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const envelope = (code: string, message: string, retryable = false) => ({ error: { code, message, requestId: "00000000-0000-4000-8000-000000000000", retryable } });
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });
const focusWindow = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
const quiet = (page: Page) => page.waitForTimeout(500); // a bounded window in which a premature write would already have shown

type Ids = { flowId: string; otherFlowId: string; startId: string; payId: string; shipId: string; doneId: string };

/** Two flows; the first has Start → Pay, plus Ship and Done for the person to connect locally. */
async function seed(page: Page, projectId: string): Promise<Ids> {
  const [flowId, otherFlowId, startId, payId, shipId, doneId] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
  const node = (id: string, kind: string, label: string) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [id] });
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Writes", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    node(startId, "START", "Start"), node(payId, "ACTION", "Pay"), node(shipId, "ACTION", "Ship"), node(doneId, "ACTION", "Done"),
    { command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" }, proposedIds: [randomUUID()] },
    { command: "CREATE_FLOW", payload: { title: "Zulu", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [otherFlowId] },
  ]);
  return { flowId, otherFlowId, startId, payId, shipId, doneId };
}

/** Pauses, answers or fails one project's status reads; everything else reaches the real server. */
async function controlStatus(page: Page, projectId: string) {
  const held: Route[] = [];
  let mode: "pass" | "hold" | { fail: number } = "pass";
  let requests = 0;
  await page.route(`**/api/projects/${projectId}/status`, async (route) => {
    requests++;
    if (mode === "hold") { held.push(route); return; }
    if (typeof mode === "object") { await route.fulfill({ status: mode.fail, json: envelope(mode.fail === 503 ? "UNAVAILABLE" : mode.fail === 404 ? "NOT_FOUND" : "FORBIDDEN", "No.", mode.fail === 503) }); return; }
    await route.continue();
  });
  return {
    hold() { mode = "hold"; },
    pass() { mode = "pass"; },
    failWith(code: number) { mode = { fail: code }; },
    requests: () => requests,
    held: () => held.length,
    /** Lets the paused reads reach the real server (or answers them with an error). */
    async release(answer?: number) {
      // A denial or failure keeps answering: a blur or focus arriving meanwhile makes the controller ask again, and that read must fail too.
      mode = answer ? { fail: answer } : "pass";
      for (const route of held.splice(0)) {
        if (answer) await route.fulfill({ status: answer, json: envelope(answer === 503 ? "UNAVAILABLE" : answer === 404 ? "NOT_FOUND" : "FORBIDDEN", "No.", answer === 503) });
        else await route.continue();
      }
    },
  };
}

/** A real pointer connection between two steps: one local change. */
async function connect(page: Page, fromId: string, toId: string) {
  await nodeAt(page, fromId).locator('.react-flow__handle[data-handleid="bottom"]').first().dragTo(nodeAt(page, toId).locator('.react-flow__handle[data-handleid="top"]').first());
}

test.describe("writes wait for the status controller (real draft)", () => {
  let projectId: string;
  let ids: Ids;
  let writes: string[];
  let gate: Awaited<ReturnType<typeof controlStatus>>;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    projectId = await createProjectViaApi(page, "Writes project");
    ids = await seed(page, projectId);
    writes = [];
    page.on("request", (request) => { if (request.method() === "POST" && /\/(changes|positions)$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    gate = await controlStatus(page, projectId);
  });

  async function open(page: Page) {
    await page.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(page, ids.payId)).toBeVisible();
  }
  /** Focus while status is paused: the controller must revalidate, and the paused read is the first sign of it. */
  async function pauseAfterFocus(page: Page) {
    gate.hold();
    await focusWindow(page);
    await expect.poll(() => gate.held()).toBe(1);
  }
  async function editAndPause(page: Page) {
    await open(page);
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("Unsaved changes");
    await pauseAfterFocus(page);
  }

  test("Ctrl+S after focus sends nothing until the status read resolves, then saves", async ({ page }) => {
    await editAndPause(page);
    await page.keyboard.press("Control+s");
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect(status(page)).toContainText("All changes saved");
    expect(writes).toHaveLength(1);
  });

  test("autosave after focus waits for the status read", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await connect(page, ids.payId, ids.shipId);
    await pauseAfterFocus(page);
    await page.clock.runFor(10_000);
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect.poll(() => writes.length).toBe(1);
    await expect(status(page)).toContainText("All changes saved");
  });

  test("Save after focus is refused before any request when the status read says 403 or 404", async ({ page }) => {
    await editAndPause(page);
    await headerSave(page).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release(403);
    await quiet(page);
    expect(writes).toHaveLength(0);
    // The person's change is still there; the next Save (status healthy again) sends it.
    await expect(status(page)).toContainText("Unsaved changes");
    gate.pass();
    await headerSave(page).click();
    await expect(status(page)).toContainText("All changes saved");
    expect(writes).toHaveLength(1);
  });

  test("a status read that says 404 drops the project: nothing is sent and the unavailable-project recovery shows", async ({ page }) => {
    await editAndPause(page);
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ status: 404, json: envelope("NOT_FOUND", "Not found.") }));
    await headerSave(page).click();
    await gate.release(404);
    await expect(page.getByRole("heading", { level: 1, name: "Project unavailable" })).toBeVisible();
    await quiet(page);
    expect(writes).toHaveLength(0);
  });

  test("an unavailable status read shows Not saved, keeps the change and local editing, and a later Save succeeds", async ({ page }) => {
    await editAndPause(page);
    await headerSave(page).click();
    await gate.release(503);
    await expect(status(page)).toContainText("Not saved");
    expect(writes).toHaveLength(0);
    gate.failWith(503);
    await connect(page, ids.shipId, ids.doneId); // editing stays local while the API is unreachable
    await expect(status(page)).toContainText("3 connections");
    await headerSave(page).click();
    await expect(status(page)).toContainText("Not saved");
    expect(writes).toHaveLength(0);
    gate.pass();
    await headerSave(page).click();
    await expect(status(page)).toContainText("All changes saved");
    expect(writes).toHaveLength(1);
  });

  test("Arrange Apply after focus waits for the status read", async ({ page }) => {
    await open(page);
    await page.locator(".studio-toolbar").getByRole("button", { name: "Arrange" }).click();
    const arrange = dialog(page, "Arrange flow");
    await arrange.getByRole("button", { name: "Preview" }).click();
    await expect(arrange.getByRole("button", { name: "Apply arrangement" })).toBeVisible();
    await pauseAfterFocus(page);
    await arrange.getByRole("button", { name: "Apply arrangement" }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect(arrange).toBeHidden();
    expect(writes).toEqual([`/api/projects/${projectId}/drafts/${(await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft.id}/positions`]);
  });

  test("Arrange Apply is refused without a request when status is unavailable", async ({ page }) => {
    await open(page);
    await page.locator(".studio-toolbar").getByRole("button", { name: "Arrange" }).click();
    const arrange = dialog(page, "Arrange flow");
    await arrange.getByRole("button", { name: "Preview" }).click();
    await expect(arrange.getByRole("button", { name: "Apply arrangement" })).toBeVisible();
    await pauseAfterFocus(page);
    await arrange.getByRole("button", { name: "Apply arrangement" }).click();
    await gate.release(503);
    await expect(arrange.getByRole("alert")).toContainText("Not saved");
    expect(writes).toHaveLength(0);
  });

  test("creating a flow and duplicating one save through the barrier", async ({ page }) => {
    await editAndPause(page);
    await page.locator(".flow-switch").click();
    const flows = dialog(page, "Flows");
    await flows.getByRole("button", { name: "New flow" }).click();
    const create = dialog(page, "New flow");
    await create.getByLabel("Title").fill("Created while paused");
    await create.getByRole("button", { name: "Create flow" }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect(page.locator("#studio-flow-title")).toHaveText("Created while paused");
    await expect.poll(() => writes.length).toBe(1);

    await pauseAfterFocus(page);
    await page.locator(".flow-switch").click();
    await dialog(page, "Flows").getByRole("button", { name: "Duplicate Created while paused" }).click();
    await quiet(page);
    expect(writes).toHaveLength(1); // nothing was unsaved, so only the copy's own save on open remains, and it waits
    await gate.release();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Created while paused");
    await expect.poll(() => writes.length).toBe(2);
  });

  test("a flow switch's save-first waits for the status read, and stays put when it is denied", async ({ page }) => {
    await editAndPause(page);
    await page.locator(".flow-switch").click();
    await dialog(page, "Flows").getByRole("button", { name: /Zulu/ }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release(403);
    await expect(dialog(page, "Flows")).toContainText("aren’t saved");
    expect(writes).toHaveLength(0);
    await expect(page.locator("#studio-flow-title")).toHaveText("Writes");

    await pauseAfterFocus(page);
    await dialog(page, "Flows").getByRole("button", { name: /Zulu/ }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect(page.locator("#studio-flow-title")).toHaveText("Zulu");
    expect(writes).toHaveLength(1);
  });

  test("a project switch's save-first waits for the status read", async ({ page }) => {
    const secondId = await createProjectViaApi(page, "Second writes project");
    await editAndPause(page);
    await page.locator("#projects-nav").getByRole("button", { name: "Second writes project", exact: true }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release(503);
    await expect(dialog(page, "Unsaved changes in Writes project")).toBeVisible();
    expect(writes).toHaveLength(0);
    await dialog(page, "Unsaved changes in Writes project").getByRole("button", { name: "Stay" }).click();

    await pauseAfterFocus(page);
    await page.locator("#projects-nav").getByRole("button", { name: "Second writes project", exact: true }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await gate.release();
    await expect(page.getByRole("heading", { level: 1, name: "Second writes project" })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(page.url()).toContain(secondId);
  });

  test("a status for another account tears the page down and navigates, with nothing sent", async ({ page }) => {
    await open(page);
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("Unsaved changes");
    const seen: string[] = [];
    await page.exposeFunction("captureAtTeardown", (text: string) => { seen.push(text); });
    await page.evaluate(() => {
      window.addEventListener("scoperoom:session-ended", () => { void (window as unknown as { captureAtTeardown: (text: string) => Promise<void> }).captureAtTeardown(document.body.innerText); });
    });
    await page.route(`**/api/projects/${projectId}/status`, async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, json: { ...(await real.json() as object), viewerId: "00000000-0000-4000-8000-000000000001" } });
    });
    await focusWindow(page);
    await expect.poll(() => seen.length).toBe(1);
    await expect(page).toHaveURL(/\/app$/);
    expect(seen[0]).toContain("Your account changed");
    for (const gone of ["Writes project", "Unsaved changes", "Start", "Pay"]) expect(seen[0], gone).not.toContain(gone);
    expect(writes).toHaveLength(0);
  });

  test("blur invalidates: autosave in a visible but unfocused window meets another account and sends nothing", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await connect(page, ids.payId, ids.shipId);
    await expect(status(page)).toContainText("Unsaved changes");
    const seen: string[] = [];
    await page.exposeFunction("captureAtTeardown", (text: string) => { seen.push(text); });
    await page.evaluate(() => {
      window.addEventListener("scoperoom:session-ended", () => { void (window as unknown as { captureAtTeardown: (text: string) => Promise<void> }).captureAtTeardown(document.body.innerText); });
    });
    // Another window of this browser signs in as someone else: from here on /status answers for that account, once released.
    const held: Route[] = [];
    await page.route(`**/api/projects/${projectId}/status`, (route) => { held.push(route); });
    await page.evaluate(() => { window.dispatchEvent(new Event("blur")); });
    await page.clock.runFor(10_000); // autosave ticks; the write must wait for a status read
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await quiet(page);
    expect(writes).toHaveLength(0);
    for (const route of held.splice(0)) {
      const real = await route.fetch();
      await route.fulfill({ response: real, json: { ...(await real.json() as object), viewerId: "00000000-0000-4000-8000-000000000001" } });
    }
    await expect.poll(() => seen.length).toBe(1);
    await expect(page).toHaveURL(/\/app$/);
    expect(seen[0]).toContain("Your account changed");
    expect(writes).toHaveLength(0);
  });

  /** 101 alternating renames of two steps: no coalescing, so the save is a real split (100 commands, then 1). */
  async function splitEdits(page: Page) {
    await open(page);
    // Autosave (10 s) must not save part of the edits while the loop runs, which is slower under load: freeze timers.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    for (let index = 0; index < 101; index++) {
      const id = index % 2 ? ids.shipId : ids.payId;
      await nodeAt(page, id).locator(".step-label").dblclick();
      await nodeAt(page, id).getByRole("textbox", { name: "Step name" }).fill(`Renamed ${index}`);
      await page.keyboard.press("Enter");
    }
    await expect(status(page)).toContainText("Unsaved changes");
  }
  /** Sends batch 1, holds its response, lands focus with status paused, then lets the receipt through: batch 2 is next in line. */
  async function pauseBetweenSplitBatches(page: Page, bodies: { commands: unknown[] }[]) {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await page.route(/\/drafts\/[^/]+\/changes$/, async (route) => { const response = await route.fetch(); await firstHeld; await route.fulfill({ response }); }, { times: 1 });
    page.on("request", (request) => { if (request.method() === "POST" && /\/changes$/.test(request.url())) bodies.push(request.postDataJSON() as { commands: unknown[] }); });
    await headerSave(page).click();
    await expect.poll(() => writes.length).toBe(1);
    await pauseAfterFocus(page);
    releaseFirst();
    await quiet(page);
    expect(writes).toHaveLength(1); // batch 2 (waiting state, its own key) waits for status
    expect(bodies.map((body) => body.commands.length)).toEqual([100]);
  }

  test("a split save's second batch waits for status after the first batch's receipt", async ({ page }) => {
    test.setTimeout(120_000);
    const bodies: { commands: unknown[] }[] = [];
    await splitEdits(page);
    await pauseBetweenSplitBatches(page, bodies);
    await gate.release();
    await expect.poll(() => writes.length).toBe(2);
    expect(bodies.map((body) => body.commands.length)).toEqual([100, 1]);
    await expect(status(page)).toContainText("All changes saved");
  });

  test("a split save's second batch is never sent after a denied or unavailable status, and resumes once it is healthy", async ({ page }) => {
    test.setTimeout(120_000);
    const bodies: { commands: unknown[] }[] = [];
    await splitEdits(page);
    await pauseBetweenSplitBatches(page, bodies);
    await gate.release(403);
    await quiet(page);
    expect(writes).toHaveLength(1);
    gate.failWith(503);
    await headerSave(page).click();
    await expect(status(page)).toContainText("Not saved");
    expect(writes).toHaveLength(1);
    gate.pass();
    await headerSave(page).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(bodies.map((body) => body.commands.length)).toEqual([100, 1]);
    await expect(status(page)).toContainText("All changes saved");
  });

  test("a save queued behind a request waits for status again when focus arrives before it starts", async ({ page }) => {
    await open(page);
    await connect(page, ids.payId, ids.shipId);
    // Hold the first save's response: the next edit queues behind it and becomes a second request.
    let releaseFirst: (() => void) | null = null;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await page.route(/\/drafts\/[^/]+\/changes$/, async (route) => {
      const response = await route.fetch();
      await firstHeld;
      await route.fulfill({ response });
    }, { times: 1 });
    await headerSave(page).click();
    await expect.poll(() => writes.length).toBe(1);
    await connect(page, ids.shipId, ids.doneId);
    await pauseAfterFocus(page); // focus lands between the two requests
    releaseFirst!();
    await quiet(page);
    expect(writes).toHaveLength(1); // the queued batch waits for status
    await gate.release();
    await expect.poll(() => writes.length).toBe(2);
    await expect(status(page)).toContainText("All changes saved");
  });
});
