import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test as collaborationTest } from "./collaboration-fixtures";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, openSpecs, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test("paste, read, correct and archive a source", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Sources project");
  await openSpecs(page, projectId, "Sources project");
  await page.getByLabel("Source title").fill("Brief");
  await page.getByLabel("Source text").fill("Customers pay by card.\r\nRefunds take 5 days.");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /Brief/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers pay by card.", "Refunds take 5 days."]);
  await page.getByLabel("Corrected text").fill("Customers pay by card or wallet.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await page.getByRole("button", { name: "v1", exact: true }).click();
  await expect(page.getByText("Viewing v1; latest v2")).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("No active sources")).toBeVisible();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("button", { name: /Brief/ })).toBeVisible();
});

test("an invalid UTF-8 upload is refused before sending", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload project");
  await openSpecs(page, projectId, "Upload project");
  await page.getByLabel("Source text").fill("typed text stays");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await expect(page.getByText("This file isn't valid UTF-8 text.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toHaveValue("typed text stays");
});

test("an upload with a BOM and CRLF counts and reads normalized lines", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload lines project");
  await openSpecs(page, projectId, "Upload lines project");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("\uFEFFfirst\r\nsecond", "utf8") });
  await expect(page.getByLabel("Source title")).toHaveValue("notes.md");
  await expect(page.getByText("12/50,000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /notes\.md/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["first", "second"]);
});

test("a correction against a newer version keeps the unsent text for retry", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Stale source project");
  await openSpecs(page, projectId, "Stale source project");
  await page.getByLabel("Source title").fill("Policy");
  await page.getByLabel("Source text").fill("Original.");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /Policy/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["Original."]);
  const head = (await (await page.request.get(`/api/projects/${projectId}/sources`)).json() as { items: Array<{ id: string; version: number; currentVersionId: string }> }).items[0]!;
  const other = await page.request.post(`/api/projects/${projectId}/sources/${head.id}/versions`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { expectedSourceRecordVersion: head.version, expectedCurrentVersionId: head.currentVersionId, title: "Policy", text: "Changed elsewhere." },
  });
  expect(other.status()).toBe(201);
  await page.getByLabel("Corrected text").fill("My unsent correction.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved this item first" })).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Changed elsewhere."]); // the newer head has been read
  await expect(page.getByLabel("Corrected text")).toHaveValue("My unsent correction.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Viewing v3; latest v3")).toBeVisible();
});

test("a saved flow is added as a source", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Flow source project");
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Manual saved flow", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "Take payment", actorLabel: "Customer" }, proposedIds: [nodeId] },
  ]);
  await openSpecs(page, projectId, "Flow source project");
  await expect(page.getByLabel("Flow source title")).toHaveValue("Checkout");
  await expect(page.getByText("Uses the last saved version of the flow.")).toBeVisible();
  await page.getByRole("button", { name: "Add flow as source" }).click();
  await page.getByRole("button", { name: /Checkout.*Saved flow/ }).click();
  await expect(page.locator(".source-lines")).toContainText("Pay");
});

const switchTabs = async (page: Page) => {
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Details", selected: true })).toBeVisible();
  await page.getByRole("tab", { name: "Specs", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Specs", selected: true })).toBeVisible();
};

test("an unconfirmed Add survives a tab switch and Retry creates exactly one source", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Unconfirmed add project");
  await openSpecs(page, projectId, "Unconfirmed add project");
  const keys: Array<string | undefined> = [];
  let first = true;
  await page.route(`**/api/projects/${projectId}/sources`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (!first) return route.continue();
    first = false;
    await route.fetch(); // the server commits, the answer is lost
    return route.abort();
  });
  await page.getByLabel("Source title").fill("Brief");
  await page.getByLabel("Source text").fill("Customers pay by card.");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "We couldn’t confirm" })).toBeVisible();
  await switchTabs(page);
  await expect(page.getByRole("alert").filter({ hasText: "We couldn’t confirm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add source" })).toBeDisabled();
  await expect(page.getByLabel("Source text")).toHaveValue("Customers pay by card.");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Source added.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Brief/ })).toHaveCount(1);
  const listed = await (await page.request.get(`/api/projects/${projectId}/sources`)).json() as { items: unknown[] };
  expect(listed.items).toHaveLength(1);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("the filter and the open source survive a tab switch, and focus returns after saving and after Back", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Scope persists project");
  await openSpecs(page, projectId, "Scope persists project");
  await page.getByLabel("Source title").fill("Brief");
  await page.getByLabel("Source text").fill("Customers pay by card.");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /Brief/ }).click();
  await page.getByLabel("Corrected text").fill("Customers pay by card or wallet.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brief" })).toBeFocused();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brief" })).toBeFocused();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Active", exact: true })).toBeFocused(); // the archived source is not in this list
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await page.getByRole("button", { name: /Brief/ }).click();
  await switchTabs(page);
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers pay by card or wallet."]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: /Brief/ })).toBeFocused();
});

collaborationTest("a reviewer reads sources without edit controls", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, setEditorRole } = collaboration;
  const name = "Collaboration project";
  await openSpecs(ownerPage, projectId, name);
  await ownerPage.getByLabel("Source title").fill("Brief");
  await ownerPage.getByLabel("Source text").fill("Shared text");
  await ownerPage.getByRole("button", { name: "Add source" }).click();
  await expect(ownerPage.getByRole("button", { name: /Brief/ })).toBeVisible();
  await setEditorRole("REVIEWER");
  await openSpecs(editorPage, projectId, name);
  await expect(editorPage.getByRole("button", { name: /Brief/ })).toBeVisible();
  await expect(editorPage.getByLabel("Source text")).toHaveCount(0);
  await editorPage.getByRole("button", { name: /Brief/ }).click();
  await expect(editorPage.locator(".source-lines li")).toHaveText(["Shared text"]);
  await expect(editorPage.getByRole("button", { name: "Save new version" })).toHaveCount(0);
  await expect(editorPage.getByLabel("Corrected text")).toHaveCount(0);
  await expect(editorPage.getByRole("button", { name: "Archive" })).toHaveCount(0);
});
