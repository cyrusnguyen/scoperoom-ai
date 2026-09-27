import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const modal = (page: Page, name: string) => page.getByRole("dialog", { name });
const panel = (page: Page) => page.locator("#right-panel");

async function createFlow(page: Page, title: string) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = modal(page, "New flow");
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText(title);
}

test.describe("Studio review polish", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Studio review owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Studio review project");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Studio review project" })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("duplicates a source whose generated title is exactly 120 code points, then blocks longer sources", async ({ page }) => {
    const symbol = String.fromCodePoint(0x1f9ed);
    await createFlow(page, symbol.repeat(112));
    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    await flows.getByRole("button", { name: /^Duplicate/ }).click();

    await expect(page.locator("#studio-flow-title")).toHaveText(`Copy of ${symbol.repeat(112)}`);
    const copied = await page.locator("#studio-flow-title").textContent();
    expect([...copied!]).toHaveLength(120);

    await page.locator(".flow-switch").click();
    await expect(flows.getByRole("button", { name: /^Duplicate/ })).toBeDisabled();
    await expect(flows.getByText(/title cannot be duplicated because.*Copy of.*120-character limit/)).toBeVisible();

    await flows.getByRole("button", { name: "New flow" }).click();
    const form = modal(page, "New flow");
    const tooLong = symbol.repeat(113);
    await form.getByLabel("Title").fill(tooLong);
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText(tooLong);
    await page.locator(".flow-switch").click();
    await expect(flows.getByRole("button", { name: /^Duplicate/ })).toBeDisabled();
  });

  test("keeps Inspector and Flows controls at 44 px when a 900 px viewport leaves a narrow editor", async ({ page }) => {
    await createFlow(page, "Intake");
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const add = modal(page, "Add step");
    await add.getByLabel("Name").fill("Receive form");
    await add.getByRole("button", { name: "Add step" }).click();
    await expect(add).toBeHidden();

    await page.setViewportSize({ width: 900, height: 844 });
    const editorWidth = await page.locator(".project-editor").evaluate((element) => element.getBoundingClientRect().width);
    expect(editorWidth).toBeLessThan(640);

    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    for (const control of [flows.getByRole("button", { name: "New flow" }), flows.getByLabel("Show"), flows.getByRole("button", { name: "Close" })]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await flows.getByRole("button", { name: "Close" }).click();

    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Receive form/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(panel(page)).toBeVisible();
    for (const control of [panel(page).getByLabel("Name"), panel(page).getByRole("button", { name: "Save", exact: true })]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
