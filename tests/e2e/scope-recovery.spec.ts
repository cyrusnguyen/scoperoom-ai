import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import type { ProjectBootstrap } from "../../src/features/projects/contracts/project";
import { test } from "./studio-fixtures";
import { createProjectViaApi, e2eReady, openSpecs } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

for (const readOutcome of ["failed", "below-floor"] as const) test(`an acknowledged requirement keeps its exact receipt through a ${readOutcome} covering read`, async ({ page }) => {
  const projectId = await createProjectViaApi(page, `Acknowledged requirement ${readOutcome}`);
  await openSpecs(page, projectId, `Acknowledged requirement ${readOutcome}`);
  const initial = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string } }).draft;
  const commandPath = `/api/projects/${projectId}/drafts/${initial.id}/commands`;
  const draftPath = `/api/projects/${projectId}/drafts/${initial.id}`;
  const writes: Array<{ key: string | undefined; body: string | null }> = [];
  let committed = false, firstCoveringRead = true;

  await page.route(`**${commandPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (readOutcome === "failed" && writes.length === 2) return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Refresh temporarily unavailable." } } });
    const response = await route.fetch();
    committed = true;
    await route.fulfill({ response });
  });
  await page.route(`**${draftPath}`, async (route) => {
    if (!committed || !firstCoveringRead) return route.continue();
    firstCoveringRead = false;
    if (readOutcome === "failed") return route.abort("failed");
    const response = await route.fetch();
    const draft = await response.json() as { documentRevision: number };
    return route.fulfill({ response, json: { ...draft, documentRevision: draft.documentRevision - 1 } });
  });

  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Pay by card");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Save requirement was acknowledged" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Pay by card");
  await expect(page.getByLabel("Title", { exact: true })).not.toBeEditable();
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);

  if (readOutcome === "failed") {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(page.getByRole("alert").filter({ hasText: "Save requirement was acknowledged" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Pay by card");
  }
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Save requirement: saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: /REQ-001 Pay by card/ })).toBeVisible();
  expect(writes).toHaveLength(readOutcome === "failed" ? 3 : 2);
  for (const replay of writes.slice(1)) expect(replay).toEqual(writes[0]);
  const saved = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { requirements: Record<string, { title: string }> } } }).draft;
  expect(Object.values(saved.document.requirements).map((requirement) => requirement.title)).toEqual(["Pay by card"]);
});


test("a draft replacement during the acknowledged read keeps requirement input available for recovery", async ({ page }) => {
  const name = "Requirement receipt replacement";
  const projectId = await createProjectViaApi(page, name);
  await openSpecs(page, projectId, name);
  const initial = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json()) as ProjectBootstrap;
  const replacementId = randomUUID();
  const replacement = { ...initial, project: { ...initial.project, name: "Replacement current draft" }, draft: { ...initial.draft, id: replacementId }, status: { ...initial.status, currentDraftId: replacementId } };
  let replaced = false, committed = false;
  let releaseRead!: () => void, observeRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { observeRead = resolve; });
  await page.route(`**/api/projects/${projectId}/status`, async (route) => replaced ? route.fulfill({ json: replacement.status }) : route.continue());
  await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => replaced ? route.fulfill({ json: replacement }) : route.continue());
  await page.route(`**/api/projects/${projectId}/drafts/${initial.draft.id}/commands`, async (route) => {
    const response = await route.fetch();
    committed = true;
    await route.fulfill({ response });
  });
  await page.route(`**/api/projects/${projectId}/drafts/${initial.draft.id}`, async (route) => {
    if (!committed) return route.continue();
    observeRead();
    await held;
    return route.continue();
  });
  try {
    await page.getByRole("tab", { name: "Scope" }).click();
    await page.getByRole("button", { name: "New requirement" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Pay by card");
    await page.getByRole("button", { name: "Save requirement" }).click();
    await readStarted;
    replaced = true;
    const bootstrapRead = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${projectId}/bootstrap`));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await bootstrapRead;
    await expect(page.getByRole("heading", { level: 1, name: "Replacement current draft" })).toBeVisible();
    releaseRead();
    await expect(page.getByRole("alert").filter({ hasText: "This change was saved to the previous draft" })).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Pay by card");
    await expect(page.getByLabel("Title", { exact: true })).toBeEditable();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    const saved = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json()) as ProjectBootstrap;
    expect(Object.values(saved.draft.document.requirements).map((requirement) => requirement.title)).toEqual(["Pay by card"]);
  } finally { releaseRead(); }
});
