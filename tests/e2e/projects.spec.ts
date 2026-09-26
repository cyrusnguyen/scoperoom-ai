import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type Route } from "@playwright/test";
import { adminClient, cleanupUsers, e2eReady, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const project = { id: "7f5b6c8e-2b1a-4e6f-9d3c-1a2b3c4d5e6f", name: "Browser project" };
const lists = { owned: { items: [], truncated: false }, shared: { items: [], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } };
const bootstrap = { project: { ...project, status: "ACTIVE", role: "OWNER", ownerId: project.id }, draft: { id: project.id, schemaVersion: 3, documentRevision: 1, layoutRevision: 1, documentJson: {}, layoutJson: {} } };

async function openNewProject(page: Page, handlePost: (route: Route) => Promise<void>) {
  await page.route("**/api/projects", (route) => route.request().method() === "GET" ? route.fulfill({ json: lists }) : handlePost(route));
  await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
  await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: bootstrap }));
  await page.goto("/app");
  const nav = page.locator("#projects-nav");
  await expect(nav.getByText("0 of 10 active")).toBeVisible();
  await nav.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByLabel("Project name")).toBeFocused();
  await dialog.getByLabel("Project name").fill(project.name);
  return dialog;
}

test.describe("project creation", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Creation Test");
  });

  test.afterEach(async () => {
    try { await cleanupUsers(database, admin, users); } finally { await database.end(); }
  });

  test("creates a named project from the sidebar, sends one request per activation, and opens it", async ({ page }) => {
    const keys: string[] = [];
    const dialog = await openNewProject(page, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ name: project.name });
      keys.push(route.request().headers()["idempotency-key"]!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 201, json: { ...project, replayed: false } });
    });
    await dialog.getByRole("button", { name: "Create" }).dblclick();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeFocused();
    await expect(page.locator(".app-footer").getByRole("status")).toHaveText(`Created ${project.name}.`);
    expect(keys).toHaveLength(1);
  });

  test("an uncertain create keeps the name and retries with the same key", async ({ page }) => {
    const keys: string[] = [];
    const dialog = await openNewProject(page, async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (keys.length === 1) await route.abort("failed");
      else await route.fulfill({ status: 201, json: { ...project, replayed: false } });
    });
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("We could not confirm project creation. Retry uses the same request.");
    await expect(dialog.getByLabel("Project name")).toHaveValue(project.name);
    await expect(dialog.getByLabel("Project name")).toBeDisabled();
    await dialog.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  test("a refused create keeps the dialog open with the name editable", async ({ page }) => {
    const message = "You've reached your active project limit. Archive a project or ask for a higher limit.";
    const dialog = await openNewProject(page, (route) => route.fulfill({ status: 422, json: { error: { code: "OWNED_PROJECT_LIMIT", message, requestId: "00000000-0000-4000-8000-000000000000", retryable: false, details: { activeOwned: 10, maxOwned: 10 } } } }));
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(message);
    await expect(dialog.getByLabel("Project name")).toBeEnabled();
    await expect(dialog.getByLabel("Project name")).toHaveValue(project.name);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
