import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, seedStudioChanges } from "./support";

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
  await page.goto(`/app/projects/${projectId}`);
  const toolbar = page.locator(".studio-toolbar");
  await expect(toolbar).toBeVisible();

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
  await page.locator("#projects-nav").getByRole("button", { name: "Second polling project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Second polling project" })).toBeVisible();
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
  // Another window archives the project: the next status differs in lifecycle, so the controller asks for a bootstrap.
  const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { version: number };
  const archived = await page.request.post(`/api/projects/${projectId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: status.version, reason: "Finished" } });
  expect(archived.status()).toBe(200);
  await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "No.", requestId: "00000000-0000-4000-8000-000000000000", retryable: true } } }), { times: 1 });
  const failed = page.waitForResponse((response) => /\/bootstrap$/.test(new URL(response.url()).pathname) && response.status() === 503);
  await page.clock.runFor(11_000);
  await failed;
  await page.waitForTimeout(300);
  await expect(toolbar).toBeVisible();
  await expect(page.locator("#studio-flow-title")).toHaveText("Transient");
  await expect(page.getByRole("heading", { level: 1, name: "Project unavailable" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore…" })).toHaveCount(0); // still the active view
  const recovered = page.waitForResponse((response) => /\/bootstrap$/.test(new URL(response.url()).pathname) && response.status() === 200);
  await page.clock.runFor(11_000);
  await recovered;
  await expect(page.getByRole("button", { name: "Restore…" })).toBeVisible();
  await expect(toolbar).toBeVisible();
});
