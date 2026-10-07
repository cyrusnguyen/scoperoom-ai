import { randomUUID } from "node:crypto";
import { expect, type Page, type Request as BrowserRequest } from "@playwright/test";
import { test as collaborationTest } from "./collaboration-fixtures";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, openSpecs, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const requestSettled = (page: Page, target: BrowserRequest) => new Promise<void>((resolve) => {
  const done = (request: BrowserRequest) => {
    if (request !== target) return;
    page.off("requestfinished", done); page.off("requestfailed", done); resolve();
  };
  page.on("requestfinished", done); page.on("requestfailed", done);
});
const browserFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("paste, read, correct and archive a source", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Sources project");
  await openSpecs(page, projectId, "Sources project");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Source title")).toBeVisible();
  await expect.poll(() => pageFits(page)).toBe(true); // the add form
  await page.getByLabel("Source title").fill("Brief");
  await page.getByLabel("Source text").fill("Customers pay by card.\r\nRefunds take 5 days.");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /Brief/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers pay by card.", "Refunds take 5 days."]);
  await expect(page.getByLabel("Corrected text")).toBeVisible();
  await expect.poll(() => pageFits(page)).toBe(true); // the reader with its correction form
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

test("uploads keep their BOM for the server; invalid UTF-8 is refused before sending", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload project");
  await openSpecs(page, projectId, "Upload project");
  await page.getByLabel("Source text").fill("typed text stays");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await expect(page.getByText("This file isn't valid UTF-8 text.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toHaveValue("typed text stays");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(320 * 1024 + 1, "a") });
  await expect(page.getByText("This file is too large to add as a source.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toHaveValue("typed text stays");

  const bodies: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`/api/projects/${projectId}/sources`)) bodies.push(request.postData() ?? ""); });
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "bom.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb")]) });
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /bom/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["a", "b"]);
  expect(JSON.parse(bodies[0]!).text.startsWith("\uFEFF")).toBe(true);
});

test("an upload with a BOM and CRLF counts and reads normalized lines", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload lines project");
  await openSpecs(page, projectId, "Upload lines project");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("\uFEFFfirst\r\nsecond", "utf8") });
  await switchTabs(page);
  await expect(page.getByLabel("Source title")).toHaveValue("notes.md");
  await expect(page.getByText("12/50,000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("button", { name: /notes\.md.*Uploaded/ })).toBeVisible();
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
  const flowId = randomUUID(), nodeId = randomUUID(), otherFlowId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Manual saved flow", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "Take payment", actorLabel: "Customer" }, proposedIds: [nodeId] },
    { command: "CREATE_FLOW", payload: { title: "Returns", purpose: "Return goods", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [otherFlowId] },
  ]);
  await openSpecs(page, projectId, "Flow source project");
  const chosen = await page.getByLabel("Flow", { exact: true }).inputValue() === flowId ? otherFlowId : flowId;
  const chosenTitle = chosen === otherFlowId ? "Returns" : "Checkout";
  await page.getByLabel("Flow", { exact: true }).selectOption(chosen);
  await page.getByLabel("Flow source title").fill("Selected flow evidence");
  await switchTabs(page);
  await expect(page.getByLabel("Flow", { exact: true })).toHaveValue(chosen);
  await expect(page.getByLabel("Flow source title")).toHaveValue("Selected flow evidence");
  await expect(page.getByText("Uses the last saved version of the flow.")).toBeVisible();
  await page.getByRole("button", { name: "Add flow as source" }).click();
  await page.getByRole("button", { name: /Selected flow evidence.*Saved flow/ }).click();
  await expect(page.locator(".source-lines")).toContainText(`Flow: ${chosenTitle}`);
  if (chosen === flowId) await expect(page.locator(".source-lines")).toContainText("Pay");
  else await expect(page.locator(".source-lines")).not.toContainText("Pay");
});

const switchTabs = async (page: Page) => {
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Details", selected: true })).toBeVisible();
  await page.getByRole("tab", { name: "Specs", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Specs", selected: true })).toBeVisible();
};

test("a lost source acknowledgement survives a tab switch and replays its exact request", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Unconfirmed add project");
  await openSpecs(page, projectId, "Unconfirmed add project");
  const sent: Array<{ key: string | undefined; body: string }> = [];
  let first = true;
  await page.route(`**/api/projects/${projectId}/sources`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() ?? "" });
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
  await expect(page.getByLabel("Source text")).not.toBeEditable(); // locked while the request is unconfirmed, so a retry cannot lose later edits
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Add source: saved.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toBeEditable();
  await expect(page.getByLabel("Source text")).toHaveValue(""); // a retried success clears the form, so one more click cannot add a duplicate
  await expect(page.getByLabel("Source title")).toHaveValue("");
  await expect(page.getByRole("button", { name: /Brief/ })).toHaveCount(1);
  const listed = await (await page.request.get(`/api/projects/${projectId}/sources`)).json() as { items: unknown[] };
  expect(listed.items).toHaveLength(1);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]); // the identical key and body
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
  // The active list no longer includes this source, but its exact reader survives a remount.
  await switchTabs(page);
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers pay by card or wallet."]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Active", exact: true })).toBeFocused(); // the archived source is not in this list
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await page.getByRole("button", { name: /Brief/ }).click();
  await expect(page.getByRole("heading", { name: "Brief" })).toBeFocused(); // opened by the person, so focus follows once it loads
  await switchTabs(page);
  const specsTab = page.getByRole("tab", { name: "Specs", exact: true });
  await expect(specsTab).toBeFocused();
  await page.getByRole("tab", { name: "Details", exact: true }).focus();
  await page.keyboard.press("ArrowLeft"); // the Reader must not take focus from the tablist
  await expect(specsTab).toBeFocused();
  await expect(specsTab).toHaveAttribute("aria-selected", "true");
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

test("a source response that arrives after a project switch has no effect on the new project", async ({ page }) => {
  const first = await createProjectViaApi(page, "Old project"), second = await createProjectViaApi(page, "New project");
  await openSpecs(page, first, "Old project");
  let release: (() => void) | undefined;
  await page.route(`**/api/projects/${first}/sources`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in again.", requestId: "test", retryable: false } }) });
  });
  await page.getByLabel("Source title").fill("Late");
  await page.getByLabel("Source text").fill("Held");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  // Switch in place through the Projects sidebar: a full navigation would drop the held request and test nothing.
  await page.locator("#projects-nav .project-row", { hasText: "New project" }).click();
  const discard = page.getByRole("button", { name: /Discard/ });
  if (await discard.isVisible()) await discard.click(); // the typed source text still counts as unsaved input
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  release!();
  await page.waitForTimeout(1_000); // give the late 401 time to run any effect it (wrongly) still had
  expect(page.url()).toContain(`/app/projects/${second}`);
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  // The old project kept its request unresolved: back there it is still retryable.
  await page.locator("#projects-nav .project-row", { hasText: "Old project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Old project" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "We couldn’t confirm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a duplicate retry acknowledgement cannot erase newer source input", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Duplicate acknowledgement project");
  await openSpecs(page, projectId, "Duplicate acknowledgement project");
  let attempts = 0, release: (() => void) | undefined, settled: Promise<void> | undefined;
  const sent: Array<{ key: string | undefined; body: string | null }> = [];
  await page.route(`**/api/projects/${projectId}/sources`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const attempt = ++attempts, response = await route.fetch();
    if (attempt === 1) return route.abort();
    if (attempt === 2) {
      settled = requestSettled(page, route.request());
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return route.fulfill({ response });
  });
  await page.getByLabel("Source title").fill("First");
  await page.getByLabel("Source text").fill("Submitted text");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await switchTabs(page);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Add source: saved.")).toBeVisible();
  await page.getByLabel("Source title").fill("New title");
  await page.getByLabel("Source text").fill("New unsent text");
  release!();
  await settled;
  await browserFrames(page);
  await expect(page.getByLabel("Source title")).toHaveValue("New title");
  await expect(page.getByLabel("Source text")).toHaveValue("New unsent text");
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]); expect(sent[2]).toEqual(sent[0]);
});

test("a held source page cannot end the session after a project switch", async ({ page }) => {
  const first = await createProjectViaApi(page, "Paged old project"), second = await createProjectViaApi(page, "Paged new project");
  await page.request.post(`/api/projects/${first}/sources`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: "Brief", text: "Source" } });
  let release: (() => void) | undefined, settled: Promise<void> | undefined;
  await page.route(`**/api/projects/${first}/sources?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      settled = requestSettled(page, route.request());
      await new Promise<void>((resolve) => { release = resolve; });
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in again." } }) });
    }
    const response = await route.fetch(), body = await response.json();
    return route.fulfill({ response, json: { ...body, nextCursor: body.items[0].id } });
  });
  await openSpecs(page, first, "Paged old project");
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator("#projects-nav .project-row", { hasText: "Paged new project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Paged new project" })).toBeVisible();
  release!();
  await settled;
  await browserFrames(page);
  expect(page.url()).toContain(`/app/projects/${second}`);
  await expect(page.getByRole("heading", { level: 1, name: "Paged new project" })).toBeVisible();
});

test("version paging is single-flight and a held page cannot join a newer head", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Paged versions project");
  const created = await (await page.request.post(`/api/projects/${projectId}/sources`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: "Brief", text: "Original" } })).json();
  const versionPath = `/api/projects/${projectId}/sources/${created.sourceId}/versions`;
  let release: (() => void) | undefined, pageCalls = 0, settled: Promise<void> | undefined;
  await page.route(`**${versionPath}*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      pageCalls += 1;
      settled = requestSettled(page, route.request());
      await new Promise<void>((resolve) => { release = resolve; });
      return route.fulfill({ json: { items: [{ id: randomUUID(), sequence: 0, codePointCount: 1 }], nextCursor: null } });
    }
    const response = await route.fetch(), body = await response.json();
    return route.fulfill({ response, json: { ...body, nextCursor: 1 } });
  });
  await openSpecs(page, projectId, "Paged versions project");
  await page.getByRole("button", { name: /Brief/ }).click();
  await page.getByRole("button", { name: "Load more versions", exact: true }).dblclick();
  await expect.poll(() => pageCalls).toBe(1);
  await page.getByLabel("Corrected text").fill("Corrected");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await expect(page.getByRole("button", { name: "v2", exact: true })).toBeVisible();
  release!();
  await settled;
  await browserFrames(page);
  await expect(page.getByRole("button", { name: "v0", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "v1", exact: true })).toHaveCount(1);
});
