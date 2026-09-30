import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./studio-fixtures";
import { createProjectViaApi, e2eReady, seedStudioChanges } from "./support";

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
