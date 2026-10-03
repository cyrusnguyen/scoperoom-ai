import { randomUUID } from "node:crypto";
import { expect, type Route } from "@playwright/test";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// One status controller per visible project (Stage 04.2): panels, views and project switches never add a timer.
test("panel, view and project switches keep one status poll per window", async ({ page }) => {
  test.setTimeout(90_000);
  const projectId = await createProjectViaApi(page, "Polling project");
  await seedStudioChanges(page, projectId, [{ command: "CREATE_FLOW", payload: { title: "Polling", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [randomUUID()] }]);
  const otherId = await createProjectViaApi(page, "Second polling project");
  const polls: string[] = [];
  page.on("request", (request) => { const match = /\/api\/projects\/([^/]+)\/status$/.exec(new URL(request.url()).pathname); if (match) polls.push(match[1]!); });
  await page.clock.install();
  // A Realtime join (Stage 04.3) reads status once, outside the timer: each project's is settled before its windows are counted.
  const joinRead = (id: string) => page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${id}/status`);
  const joined = joinRead(projectId);
  await page.goto(`/app/projects/${projectId}`);
  const toolbar = page.locator(".studio-toolbar");
  await expect(toolbar).toBeVisible();
  await joined;

  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  for (let round = 0; round < 3; round++) {
    await inspect.click();
    await expect(page.locator("#right-panel")).toBeVisible();
    await toolbar.getByRole("button", { name: "List" }).click();
    await toolbar.getByRole("button", { name: "Canvas" }).click();
    await inspect.click();
  }

  /** Runs the fake clock through one window; a single timer can fire at most once in it (delays are 9 to 11 s). */
  const window = async () => {
    const before = polls.length;
    const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
    await page.clock.runFor(11_000);
    await answered;
    await page.waitForTimeout(200);
    return polls.slice(before);
  };
  for (let round = 0; round < 3; round++) expect(await window()).toEqual([projectId]);

  // Switching projects disposes the old controller and starts one for the new project.
  const joinedOther = joinRead(otherId);
  await page.locator("#projects-nav").getByRole("button", { name: "Second polling project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Second polling project" })).toBeVisible();
  await joinedOther;
  for (let round = 0; round < 2; round++) expect(await window()).toEqual([otherId]);
});

// A background bootstrap (here a lifecycle change found by polling) that fails transiently must not tear the Studio down.
test("a transient bootstrap failure in the background keeps the Studio mounted and the next poll recovers", async ({ page }) => {
  test.setTimeout(90_000);
  const projectId = await createProjectViaApi(page, "Transient project");
  await seedStudioChanges(page, projectId, [{ command: "CREATE_FLOW", payload: { title: "Transient", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [randomUUID()] }]);
  await page.clock.install();
  await page.goto(`/app/projects/${projectId}`);
  const toolbar = page.locator(".studio-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(page.locator("#studio-flow-title")).toHaveText("Transient");
  // Another window archives the project: the next status differs in lifecycle, so the controller asks for a bootstrap. With Realtime live that read may
  // come from the archive's committed hint or the join read before any poll, so the bootstrap fails for as long as the route is held, whichever read asks.
  const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { version: number };
  const unavailable = (route: Route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "No.", requestId: "00000000-0000-4000-8000-000000000000", retryable: true } } });
  await page.route(`**/api/projects/${projectId}/bootstrap`, unavailable);
  let failedReads = 0;
  let recoveredReads = 0;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== `/api/projects/${projectId}/bootstrap`) return;
    if (response.status() === 503) failedReads++;
    if (response.status() === 200) recoveredReads++;
  });
  const archived = await page.request.post(`/api/projects/${projectId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: status.version, reason: "Finished" } });
  expect(archived.status()).toBe(200);
  // Drive one full 9-11 s polling window before observing the real response counter.
  // Clock advancement has its own completion phase; it must not consume the counter assertion deadline.
  await page.clock.runFor(11_000);
  await expect.poll(() => failedReads, { timeout: 5_000, intervals: [25] }).toBeGreaterThan(0);
  await expect(toolbar).toBeVisible();
  await expect(page.locator("#studio-flow-title")).toHaveText("Transient");
  await expect(page.getByRole("heading", { level: 1, name: "Project unavailable" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore…" })).toHaveCount(0); // still the active view
  const beforeRecovery = recoveredReads;
  await page.unroute(`**/api/projects/${projectId}/bootstrap`, unavailable);
  // Advance the next full polling window, then observe its actual successful response.
  await page.clock.runFor(11_000);
  await expect.poll(() => recoveredReads, { timeout: 5_000, intervals: [25] }).toBeGreaterThan(beforeRecovery);
  await expect(page.getByRole("button", { name: "Restore…" })).toBeVisible();
  await expect(toolbar).toBeVisible();
});

// A bootstrap installed outside the controller (here the banner's Restore) must not leave the archived status as write authority.
test("a project restored in place saves its first edit before any poll runs", async ({ page }) => {
  test.setTimeout(90_000);
  const projectId = await createProjectViaApi(page, "Restored in place");
  const [flowId, nodeId] = [randomUUID(), randomUUID()];
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Restored", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { version: number };
  const archived = await page.request.post(`/api/projects/${projectId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: status.version, reason: "Finished" } });
  expect(archived.status()).toBe(200);
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/changes$/.test(request.url())) writes.push(request.url()); });
  await page.clock.install();
  await page.goto(`/app/projects/${projectId}`);
  await expect(page.getByRole("button", { name: "Restore…" })).toBeVisible();
  await page.clock.pauseAt(new Date(Date.now() + 2_000)); // from here no poll can run: the archived status is all the controller has read
  await page.getByRole("button", { name: "Restore…" }).click();
  await page.clock.runFor(10); // the dialog reads its preview from a 0 ms timer
  await page.getByRole("dialog", { name: "Restore Restored in place?" }).getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore…" })).toHaveCount(0);
  const step = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await step.locator(".step-label").dblclick();
  await step.getByRole("textbox", { name: "Step name" }).fill("Renamed");
  await page.keyboard.press("Enter");
  await headerSave(page).click();
  await expect(page.locator(".studio-status")).toContainText("All changes saved");
  expect(writes).toHaveLength(1);
});
