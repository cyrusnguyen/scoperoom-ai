import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./studio-fixtures";
import { createProjectViaApi, e2eReady, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test.beforeEach(async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Flow dialog review");
  const flowId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Complete an order", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Begin", description: "", actorLabel: "" }, proposedIds: [randomUUID()] },
  ]);
  await page.goto(`/app/projects/${projectId}`);
  await expect(page.locator("#studio-flow-title")).toHaveText("Checkout");
});

test("Inspect opens the current flow and keeps project details reachable without a Flow details button", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Flow details", exact: true })).toHaveCount(0);
  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  if (await inspect.getAttribute("aria-pressed") === "true") await inspect.click();
  await inspect.click();
  const panel = page.locator("#right-panel");
  await expect(panel.getByLabel("Title", { exact: true })).toHaveValue("Checkout");
  await expect(panel.getByLabel("Purpose")).toHaveValue("Complete an order");
  await panel.getByRole("button", { name: "Back to project", exact: true }).click();
  await expect(panel.getByLabel("Project name", { exact: true })).toBeVisible();
});

test("Flows explains an empty filter and restores the flow list", async ({ page }) => {
  await page.locator(".flow-switch").click();
  const dialog = page.getByRole("dialog", { name: "Flows", exact: true });
  await dialog.getByLabel("Show", { exact: true }).selectOption("INCLUDED");
  await expect(dialog.getByText("No flows match this filter.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Show all flows", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Checkout/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import flow", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Export flow", exact: true })).toBeEnabled();
});
