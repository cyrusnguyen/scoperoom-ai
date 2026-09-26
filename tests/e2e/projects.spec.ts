import { expect, test, type Route } from "@playwright/test";
import { adminClient, cleanupUsers, e2eReady, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const project = { id: "7f5b6c8e-2b1a-4e6f-9d3c-1a2b3c4d5e6f", name: "Browser project" };
const lists = (canCreate: boolean, entitled = true) => ({
  owned: { items: [], truncated: false }, shared: { items: [], truncated: false }, archived: { items: [], truncated: false },
  capacity: { entitled, activeOwned: 0, maxOwned: entitled ? 10 : 0, canCreate },
});

test.describe("project shell", () => {
  test("creates a named project from the sidebar and opens it", async ({ page }) => {
    const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
    try {
      await signIn(page, admin, users);
      await page.route("**/api/projects", async (route: Route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: lists(true) });
        expect(route.request().postDataJSON()).toEqual({ name: project.name });
        return route.fulfill({ status: 201, json: { ...project, replayed: false } });
      });
      await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...project, status: "ACTIVE", role: "OWNER", ownerId: project.id }, draft: { id: project.id, schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } } }));
      await page.reload();
      await expect(page.getByText("0 of 10 active projects")).toBeVisible();
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByLabel("Project name").fill(project.name);
      await page.getByRole("button", { name: "Create project" }).last().click();
      await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
      await expect(page.getByRole("complementary", { name: "Project details" }).getByRole("heading", { name: project.name })).toBeVisible();
    } finally { await cleanupUsers(database, admin, users); await database.end(); }
  });

  test("hides creation for an account without an entitlement", async ({ page }) => {
    const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
    try {
      await signIn(page, admin, users);
      await page.route("**/api/projects", (route) => route.fulfill({ json: lists(false, false) }));
      await page.reload();
      await expect(page.getByText("Creating projects isn't enabled for this account.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
    } finally { await cleanupUsers(database, admin, users); await database.end(); }
  });

  test("an uncertain create keeps the name and retries with the same key", async ({ page }) => {
    const admin = adminClient(); const database = await openDatabase(); const users: string[] = [];
    try {
      await signIn(page, admin, users);
      const keys: string[] = [];
      await page.route("**/api/projects", async (route: Route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: lists(true) });
        keys.push(route.request().headers()["idempotency-key"]!);
        return keys.length === 1 ? route.abort("failed") : route.fulfill({ status: 201, json: { ...project, replayed: false } });
      });
      await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...project, status: "ACTIVE", role: "OWNER", ownerId: project.id }, draft: { id: project.id, schemaVersion: 3, documentRevision: 1, layoutRevision: 1 } } }));
      await page.reload();
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByLabel("Project name").fill(project.name);
      await page.getByRole("button", { name: "Create project" }).last().click();
      await expect(page.getByRole("button", { name: "Retry project creation" })).toBeVisible();
      await expect(page.getByLabel("Project name")).toHaveValue(project.name);
      await page.getByRole("button", { name: "Retry project creation" }).click();
      await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
      expect(new Set(keys).size).toBe(1);
    } finally { await cleanupUsers(database, admin, users); await database.end(); }
  });
});
