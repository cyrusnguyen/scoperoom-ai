import { randomUUID } from "node:crypto";
import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Details' guards come from the name it shows; a poll that sees another tab's rename either moves both or keeps the
// person's typed name and lets the save conflict into the re-read recovery.
async function renameElsewhere(page: Page, projectId: string, name: string) {
  const before = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { settingsVersion: number };
  const response = await page.request.patch(`/api/projects/${projectId}/settings`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name, expectedSettingsVersion: before.settingsVersion } });
  expect(response.status()).toBe(200);
}
async function poll(page: Page) {
  const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
  await page.clock.runFor(11_000);
  await answered;
}
async function designateElsewhere(page: Page, projectId: string, profileId: string) {
  const before = await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { approvalPolicyVersion: number };
  const response = await page.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { designatedApproverId: profileId, expectedApprovalPolicyVersion: before.approvalPolicyVersion } });
  expect(response.status()).toBe(200);
}
const ownerOf = async (page: Page, projectId: string) => (await (await page.request.get(`/api/projects/${projectId}/members`)).json() as { members: { profileId: string; role: string }[] }).members.find((member) => member.role === "OWNER")!.profileId;
const policyVersion = async (page: Page, projectId: string) => (await (await page.request.get(`/api/projects/${projectId}/status`)).json() as { approvalPolicyVersion: number }).approvalPolicyVersion;
const savedName = async (page: Page, projectId: string) => (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { project: { name: string } }).project.name;

test.describe("Details after another tab renames", () => {
  test("with nothing typed, a poll shows the new name", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Original name");
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const nameField = page.locator("#right-panel").getByLabel("Project name");
    await expect(nameField).toHaveValue("Original name");
    await renameElsewhere(page, projectId, "Renamed elsewhere");
    await poll(page);
    await expect(page.getByRole("heading", { level: 1, name: "Renamed elsewhere" })).toBeVisible();
    await expect(nameField).toHaveValue("Renamed elsewhere");
  });

  test("a name typed before the poll is kept, and its save conflicts instead of overwriting the rename", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Original name");
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");
    await nameField.fill("My name");
    await renameElsewhere(page, projectId, "Their name");
    await poll(page);
    await expect(nameField).toHaveValue("My name");
    await expect(page.getByRole("heading", { level: 1, name: "Original name" })).toBeVisible();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("That change conflicts with current data. Refresh and try again.");
    await expect(page.getByRole("heading", { level: 1, name: "Their name" })).toBeVisible();
    await expect(nameField).toHaveValue("My name");
    expect(await savedName(page, projectId)).toBe("Their name");
  });

  test("with no approver chosen, a poll shows the approver designated elsewhere", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Approver project");
    const ownerId = await ownerOf(page, projectId);
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const select = page.locator("#right-panel").getByLabel("Designated approver");
    await expect(select).toHaveValue("");
    await designateElsewhere(page, projectId, ownerId);
    await poll(page);
    await expect(select).toHaveValue(ownerId);
  });

  test("an approver chosen before the poll is kept, and its save conflicts instead of being accepted on the new version", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Approver project");
    const ownerId = await ownerOf(page, projectId);
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const select = panel.getByLabel("Designated approver");
    await select.selectOption(ownerId);
    await designateElsewhere(page, projectId, ownerId);
    const version = await policyVersion(page, projectId);
    await poll(page);
    await expect(select).toHaveValue(ownerId);
    await panel.getByRole("button", { name: "Save approver" }).click();
    await expect(panel.getByRole("alert")).toHaveText("That change conflicts with current data. Refresh and try again.");
    expect(await policyVersion(page, projectId)).toBe(version); // the save was refused, not applied on the polled version
  });

  test("a bootstrap read newer than the last poll shows the approver it guards with", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Approver project");
    const ownerId = await ownerOf(page, projectId);
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const select = panel.getByLabel("Designated approver");
    await expect(select).toHaveValue("");
    await designateElsewhere(page, projectId, ownerId);
    // Cancelling a lifecycle dialog re-reads the bootstrap without any status poll in between.
    await panel.getByRole("button", { name: "Archive project…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(select).toHaveValue(ownerId);
  });
});

// Details and Share writes go through the same write barrier as the Studio: after a focus the click waits for a status read
// (another window may have signed in as someone else), and nothing is sent before it answers.
test.describe("Details writes wait for the status controller", () => {
  async function holdAfterFocus(page: Page, projectId: string) {
    await page.waitForLoadState("networkidle"); // Details' own load has finished: a request in flight would already cover the focus
    const held: Route[] = [];
    let hold = false;
    await page.route(`**/api/projects/${projectId}/status`, async (route) => { if (hold) held.push(route); else await route.continue(); });
    hold = true;
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    await expect.poll(() => held.length).toBe(1);
    return async () => { hold = false; for (const route of held.splice(0)) await route.continue(); };
  }
  const quiet = (page: Page) => page.waitForTimeout(500); // a bounded window in which a premature write would already have shown

  test("Save name sends nothing until status answers, then exactly one request", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Barrier name");
    const writes: string[] = [];
    page.on("request", (request) => { if (request.method() === "PATCH" && /\/settings$/.test(request.url())) writes.push(request.url()); });
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");
    await expect(nameField).toBeEnabled();
    await nameField.fill("Renamed behind the barrier");
    const release = await holdAfterFocus(page, projectId);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await release();
    await expect(page.getByRole("heading", { level: 1, name: "Renamed behind the barrier" })).toBeVisible();
    expect(writes).toHaveLength(1);
  });

  test("an unavailable status refuses Save name without a request and keeps the typed name", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Barrier unavailable");
    const writes: string[] = [];
    page.on("request", (request) => { if (request.method() === "PATCH" && /\/settings$/.test(request.url())) writes.push(request.url()); });
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");
    await expect(nameField).toBeEnabled();
    await nameField.fill("Kept name");
    await page.waitForLoadState("networkidle"); // Details' own load has finished: a request in flight would already cover the focus
    await page.route(`**/api/projects/${projectId}/status`, (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "No.", requestId: "00000000-0000-4000-8000-000000000000", retryable: true } } }));
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert").filter({ hasText: "Not saved. We couldn’t reach ScopeRoom." })).toBeVisible();
    expect(writes).toHaveLength(0);
    await expect(nameField).toHaveValue("Kept name");
  });

  test("Create invitation sends nothing until status answers", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Barrier invite");
    const writes: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && /\/invitations$/.test(request.url())) writes.push(request.url()); });
    await page.goto(`/app/projects/${projectId}`);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    const panel = page.locator("#right-panel");
    await panel.getByLabel("Verified email").fill("someone@example.test");
    const release = await holdAfterFocus(page, projectId);
    await panel.getByRole("button", { name: "Create invitation" }).click();
    await quiet(page);
    expect(writes).toHaveLength(0);
    await release();
    await expect.poll(() => writes.length).toBe(1);
    await expect(panel.getByLabel("One-time invitation link")).toBeVisible();
  });
});
