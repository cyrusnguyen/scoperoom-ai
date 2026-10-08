import { randomUUID } from "node:crypto";
import { expect, type Page, type Request as BrowserRequest } from "@playwright/test";
import { test as collaborationTest } from "./collaboration-fixtures";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, openSpecs, saveStudio, seedStudioChanges } from "./support";

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
  await expect(page.getByRole("button", { name: "Back", exact: true }).locator("svg")).toBeVisible();
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

test("long source readers render bounded pages with exact absolute line numbers", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Long source project");
  const text = `a${"\n".repeat(49_999)}`;
  const created = await (await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: "Many lines", text },
  })).json();
  expect(created.sourceId).toBeTruthy();
  await openSpecs(page, projectId, "Long source project");
  await page.getByRole("button", { name: /Many lines/ }).click();
  await expect(page.locator(".source-lines li")).toHaveCount(100);
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "1");
  await expect(page.locator(".source-lines li").first()).toHaveText("a");
  await expect(page.getByText("Lines 1-100 of 50,000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next lines" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "101");
  await expect(page.getByRole("button", { name: "Next lines" })).toBeFocused();
  await page.getByRole("button", { name: "Last lines" }).click();
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "49901");
  await expect(page.locator(".source-lines li")).toHaveCount(100);
  await expect(page.locator(".source-lines li").last()).toHaveText("");
  await expect(page.getByText("Lines 49,901-50,000 of 50,000", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next lines" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous lines" }).click();
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "49801");
  await page.getByRole("button", { name: "First lines" }).click();
  await expect(page.locator(".source-lines li").first()).toHaveText("a");
  await expect(page.getByLabel("Corrected text")).toHaveValue(text);

  // A newer exact version resets the page without rebasing the retained correction; comparison stays bounded too.
  await page.getByLabel("Corrected title").fill("My title");
  await page.getByRole("button", { name: "Last lines" }).click();
  const remoteText = `b${"\n".repeat(49_999)}`;
  const corrected = await page.request.post(`/api/projects/${projectId}/sources/${created.sourceId}/versions`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { expectedSourceRecordVersion: created.version, expectedCurrentVersionId: created.sourceVersionId, title: "Remote title", text: remoteText },
  });
  expect(corrected.status()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "1");
  await expect(page.locator(".source-lines li").first()).toHaveText("b");
  await expect(page.getByLabel("Current saved text")).toHaveValue(remoteText);
  await expect(page.getByLabel("Current saved text")).not.toBeEditable();
  expect(await page.getByLabel("Current saved text").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(300);
  await expect(page.getByLabel("Corrected text")).toHaveValue(text);
  await page.getByRole("button", { name: "Next lines" }).click();
  await page.getByRole("button", { name: "v1", exact: true }).click();
  await expect(page.locator(".source-lines")).toHaveAttribute("start", "1");
  await expect(page.locator(".source-lines li").first()).toHaveText("a");
});

test("uploads keep their BOM for the server; invalid UTF-8 is refused before sending", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload project");
  await openSpecs(page, projectId, "Upload project");
  await expect(page.getByText("No file selected", { exact: true })).toBeVisible();
  await page.getByLabel("Source text").fill("typed text stays");
  const upload = page.getByLabel("Upload .txt or .md");
  await upload.focus();
  await expect(upload).toBeFocused();
  expect(await upload.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  expect(await upload.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  const fileChooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await fileChooser).setFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await expect(page.getByText("This file isn't valid UTF-8 text.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toHaveValue("typed text stays");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(320 * 1024 + 1, "a") });
  await expect(page.getByText("This file is too large to add as a source.")).toBeVisible();
  await expect(page.getByLabel("Source text")).toHaveValue("typed text stays");

  const bodies: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`/api/projects/${projectId}/sources`)) bodies.push(request.postData() ?? ""); });
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "bom.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb")]) });
  await expect(page.getByText("bom.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: /bom/ }).click();
  await expect(page.locator(".source-lines li")).toHaveText(["a", "b"]);
  expect(JSON.parse(bodies[0]!).text.startsWith("\uFEFF")).toBe(true);
});

test("a pending source filter retains the visible result and panel position until its exact page arrives", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Stable source filters");
  const archived: Array<{ sourceId: string; version: number }> = [];
  for (let index = 0; index < 8; index += 1) {
    const created = await (await page.request.post(`/api/projects/${projectId}/sources`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: `Archived ${index}`, text: "Source text" },
    })).json() as { sourceId: string; version: number };
    archived.push(created);
  }
  for (const source of archived) {
    const response = await page.request.patch(`/api/projects/${projectId}/sources/${source.sourceId}`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedSourceRecordVersion: source.version, archived: true },
    });
    expect(response.status()).toBe(200);
  }
  for (let index = 0; index < 8; index += 1) await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: `Active ${index}`, text: "Source text" },
  });
  await page.setViewportSize({ width: 900, height: 300 });
  await openSpecs(page, projectId, "Stable source filters");
  await expect(page.getByRole("button", { name: /Active 7/ })).toBeVisible();
  const body = page.locator(".right-panel-body"), filter = page.getByRole("group", { name: "Source filter" });
  await filter.scrollIntoViewIfNeeded();
  const before = await body.evaluate((element) => element.scrollTop);
  const filterTop = (await filter.boundingBox())!.y;
  expect(before).toBeGreaterThan(0);
  let release: (() => void) | undefined, settled: Promise<void> | undefined;
  await page.route(`**/api/projects/${projectId}/sources?scope=archived`, async (route) => {
    settled = requestSettled(page, route.request());
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByRole("button", { name: /Active 7/ })).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  release!();
  await settled;
  await expect(page.getByRole("button", { name: /Archived 7/ })).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  expect((await filter.boundingBox())!.y).toBe(filterTop);
  await page.getByRole("button", { name: "Internal", exact: true }).click();
  await expect(page.getByText("No internal evidence yet", { exact: true })).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  expect((await filter.boundingBox())!.y).toBe(filterTop);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByRole("button", { name: /Active 7/ })).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  expect((await filter.boundingBox())!.y).toBe(filterTop);
  await page.unroute(`**/api/projects/${projectId}/sources?scope=archived`);
  await page.route(`**/api/projects/${projectId}/sources?scope=archived`, (route) => route.fulfill({
    status: 503, json: { error: { code: "UNAVAILABLE", message: "Sources unavailable. Retry." } },
  }));
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sources unavailable. Retry." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Active 7/ })).toHaveCount(0);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  expect((await filter.boundingBox())!.y).toBe(filterTop);
  await page.unroute(`**/api/projects/${projectId}/sources?scope=archived`);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: /Archived 7/ })).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(before);
  expect((await filter.boundingBox())!.y).toBe(filterTop);
});

test("an upload with a BOM and CRLF counts and reads normalized lines", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Upload lines project");
  await openSpecs(page, projectId, "Upload lines project");
  await page.getByLabel("Upload .txt or .md").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("\uFEFFfirst\r\nsecond", "utf8") });
  await switchTabs(page);
  await expect(page.getByLabel("Source title")).toHaveValue("notes.md");
  await expect(page.getByText("notes.md", { exact: true })).toBeVisible();
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
  await page.getByLabel("Corrected text").fill("My unsent correction.");
  const other = await page.request.post(`/api/projects/${projectId}/sources/${head.id}/versions`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { expectedSourceRecordVersion: head.version, expectedCurrentVersionId: head.currentVersionId, title: "Policy", text: "Changed elsewhere." },
  });
  expect(other.status()).toBe(201);
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved this item first" })).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Changed elsewhere."]); // the newer head has been read
  await expect(page.getByLabel("Corrected text")).toHaveValue("My unsent correction.");
  await page.getByRole("button", { name: "Use my edits on latest version" }).click();
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Viewing v3; latest v3")).toBeVisible();
});

for (const field of ["title", "text"] as const) test(`a ${field}-only correction keeps its inspected baseline after refresh and remount`, async ({ page }) => {
  const projectId = await createProjectViaApi(page, `Pinned ${field} correction`);
  const created = await (await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: "Original title", text: "Original text" },
  })).json();
  const path = `/api/projects/${projectId}/sources/${created.sourceId}/versions`;
  await openSpecs(page, projectId, `Pinned ${field} correction`);
  await page.getByRole("button", { name: /Original title/ }).click();
  await page.getByLabel(field === "title" ? "Corrected title" : "Corrected text").fill(`My ${field}`);
  const latest = await (await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { expectedSourceRecordVersion: created.version, expectedCurrentVersionId: created.sourceVersionId, title: "Remote title", text: "Remote text" },
  })).json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Remote text"]);
  await switchTabs(page);
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  const refused = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(path));
  await page.getByRole("button", { name: "Save new version" }).click();
  const response = await refused;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toEqual({
    expectedSourceRecordVersion: created.version, expectedCurrentVersionId: created.sourceVersionId,
    title: field === "title" ? "My title" : "Original title", text: field === "text" ? "My text" : "Original text",
  });
  await expect(page.getByLabel("Corrected title")).toHaveValue(field === "title" ? "My title" : "Original title");
  await expect(page.getByLabel("Corrected text")).toHaveValue(field === "text" ? "My text" : "Original text");
  await page.getByRole("button", { name: "Use my edits on latest version" }).click();
  await expect(page.getByLabel("Corrected title")).toHaveValue(field === "title" ? "My title" : "Remote title");
  await expect(page.getByLabel("Corrected text")).toHaveValue(field === "text" ? "My text" : "Remote text");
  const accepted = page.waitForResponse((result) => result.request().method() === "POST" && result.url().endsWith(path));
  await page.getByRole("button", { name: "Save new version" }).click();
  const saved = await accepted;
  expect(saved.status()).toBe(201);
  expect(saved.request().postDataJSON().expectedCurrentVersionId).toBe(latest.sourceVersionId);
  await expect(page.getByText("Viewing v3; latest v3")).toBeVisible();
  await page.getByLabel("Corrected title").fill("Another unsent edit");
  await page.getByRole("button", { name: "Discard my correction" }).click();
  await expect(page.getByLabel("Corrected title")).toHaveValue(field === "title" ? "My title" : "Remote title");
  await expect(page.getByRole("button", { name: "Save new version" })).toBeDisabled();
});

test("an unconfirmed correction keeps its snapshot and exact request across a project switch", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Unconfirmed correction"), otherProject = await createProjectViaApi(page, "Other correction project");
  const created = await (await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { title: "Original title", text: "Original text" },
  })).json();
  const path = `/api/projects/${projectId}/sources/${created.sourceId}/versions`;
  const sent: Array<{ key: string | undefined; body: string | null }> = [];
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (sent.length > 1) return route.continue();
    await route.fetch();
    return route.abort();
  });
  await openSpecs(page, projectId, "Unconfirmed correction");
  await page.getByRole("button", { name: /Original title/ }).click();
  await page.getByLabel("Corrected text").fill("My correction");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.locator("#projects-nav .project-row", { hasText: "Other correction project" }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Other correction project" })).toBeVisible();
  expect(page.url()).toContain(otherProject);
  await page.locator("#projects-nav .project-row", { hasText: "Unconfirmed correction" }).click();
  await expect(page.getByLabel("Corrected text")).toHaveValue("My correction");
  await expect(page.getByLabel("Corrected text")).not.toBeEditable();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Save new version: saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save new version" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard my correction" })).toHaveCount(0);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(JSON.parse(sent[0]!.body!).expectedCurrentVersionId).toBe(created.sourceVersionId);
  const versions = await (await page.request.get(path)).json();
  expect(versions.items).toHaveLength(2);
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

test("a requirement cites immutable source text, preserves local input through its reader, and tracks a changed step", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Requirement scope project");
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  await openSpecs(page, projectId, "Requirement scope project");
  await page.getByLabel("Source title", { exact: true }).fill("Brief");
  await page.getByLabel("Source text").fill("Customers pay by card.\nReceipts remain available.\n");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("😀".repeat(120));
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeEnabled();
  await page.getByLabel("Title", { exact: true }).fill("😀".repeat(121));
  await expect(page.getByRole("alert").filter({ hasText: "Title must be 120 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Title", { exact: true }).fill("Pay by card");
  await page.getByLabel("Inclusion", { exact: true }).selectOption("INCLUDED");
  await page.getByLabel("Statement", { exact: true }).fill("😀".repeat(4_001));
  await expect(page.getByRole("alert").filter({ hasText: "Statement must be 4,000 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Statement", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeEnabled(); // an empty verification method is valid
  await page.getByLabel("Verification description").fill("😀".repeat(4_001));
  await page.getByLabel("Responsible role").fill("QA");
  await expect(page.getByRole("alert").filter({ hasText: "Verification description must be 4,000 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Verification description").fill("Card payment completes successfully.");
  await page.getByLabel("Responsible role").fill("😀".repeat(121));
  await expect(page.getByRole("alert").filter({ hasText: "Responsible role must be 120 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Responsible role").fill("");
  await expect(page.getByRole("alert").filter({ hasText: "Verification description and responsible role" })).toBeVisible();
  await expect(page.getByLabel("Verification description")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Responsible role")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Responsible role").fill("QA");
  await expect(page.getByRole("alert").filter({ hasText: "Verification description and responsible role" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save requirement" }).click();
  const included = page.getByRole("region", { name: "Included" });
  await expect(included.getByRole("button", { name: /REQ-001 Pay by card/ })).toBeVisible();
  await included.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByLabel("Verification description")).toHaveValue("Card payment completes successfully.");
  await page.getByLabel("Verification description").fill("");
  await expect(page.getByRole("alert").filter({ hasText: "Verification description and responsible role" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save requirement" })).toBeDisabled();
  await page.getByLabel("Responsible role").fill("");
  await expect(page.getByRole("alert").filter({ hasText: "Verification description and responsible role" })).toHaveCount(0);
  const clearedVerification = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/commands") && response.request().postDataJSON().command === "UPDATE_REQUIREMENT");
  await page.getByRole("button", { name: "Save requirement" }).click();
  expect((await clearedVerification).request().postDataJSON()).toMatchObject({ payload: { verification: null } });
  await included.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByLabel("Verification description")).toHaveValue("");
  await expect(page.getByLabel("Responsible role")).toHaveValue("");
  await page.getByLabel("Cite source").selectOption({ label: "Brief" });
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await expect(page.getByLabel("Excerpt")).toHaveValue("Customers pay by card.");
  await page.getByLabel("Start line").fill("3");
  await page.getByLabel("End line").fill("3");
  await expect(page.getByLabel("Excerpt")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await expect(page.getByLabel("Excerpt")).toHaveValue("Customers pay by card.");
  await page.getByLabel("Excerpt").fill("Not quoted evidence.");
  await expect(page.getByRole("alert").filter({ hasText: "Excerpt must be text from the selected lines" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
  await page.getByLabel("Excerpt").fill("😀".repeat(2_001));
  await expect(page.getByRole("alert").filter({ hasText: "Excerpt must be 2,000 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
  await page.getByLabel("Excerpt").fill("Customers pay by card.");
  for (const [start, end] of [["1.5", "2"], ["1", "1.5"], ["0", "1"], ["2", "1"], ["1", "4"], ["9007199254740992", "9007199254740992"]]) {
    await page.getByLabel("Start line").fill(start!);
    await page.getByLabel("End line").fill(end!);
    await page.getByLabel("Excerpt").fill("Customers pay by card.");
    await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
    await expect(page.getByRole("alert").filter({ hasText: "Choose whole line numbers" })).toBeVisible();
    await expect(page.getByLabel("Start line")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("End line")).toHaveAttribute("aria-invalid", "true");
  }
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await expect(page.getByLabel("Excerpt")).toHaveValue("Customers pay by card.");
  await expect(page.getByRole("alert").filter({ hasText: "Choose whole line numbers" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add citation" }).click();
  await expect(page.getByRole("button", { name: /Brief v1, lines 1-1/ })).toBeVisible();
  await page.getByLabel("Cite source").selectOption({ label: "Brief" });
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await expect(page.getByLabel("Excerpt")).toHaveValue("Customers pay by card.");
  await expect(page.getByRole("alert").filter({ hasText: "This exact citation is already added" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
  const source = (await (await page.request.get(`/api/projects/${projectId}/sources`)).json() as { items: Array<{ id: string; version: number; currentVersionId: string }> }).items[0]!;
  const newerSource = await page.request.post(`/api/projects/${projectId}/sources/${source.id}/versions`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { expectedSourceRecordVersion: source.version, expectedCurrentVersionId: source.currentVersionId, title: "Brief", text: "Customers can pay by card or wallet." },
  });
  expect(newerSource.status()).toBe(201);
  await page.getByLabel("Statement", { exact: true }).fill("Keep this local statement");
  await expect(page.getByRole("button", { name: "Confirm requirement" })).toBeDisabled();
  await page.getByRole("button", { name: /Brief v1, lines 1-1/ }).click();
  await expect(page.getByText("Viewing v1; latest v2")).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers pay by card.", "Receipts remain available.", ""]);
  await expect(page.locator('.source-lines li[data-cited="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expect(page.getByText("Viewing v2; latest v2")).toBeVisible();
  await expect(page.locator(".source-lines li")).toHaveText(["Customers can pay by card or wallet."]);
  await expect(page.locator('.source-lines li[data-cited="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Keep this local statement");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await included.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await page.getByLabel("Link to step").selectOption(nodeId);
  await page.locator("#link-explanation").fill("Supports payment");
  const linkDraft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number; document: { requirements: Record<string, { id: string }> } } }).draft;
  const remoteLink = await page.request.post(`/api/projects/${projectId}/drafts/${linkDraft.id}/commands`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "ADD_TRACE_LINK", expectedDocumentRevision: linkDraft.documentRevision, payload: { requirementId: Object.values(linkDraft.document.requirements)[0]!.id, nodeId, explanation: "Supports payment" } },
  });
  expect(remoteLink.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Edit explanation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add link" })).toBeDisabled();
  await expect(page.locator("#link-step option", { hasText: "Checkout / Pay" })).toHaveCount(0);
  await expect(page.locator("#link-explanation")).toHaveValue("Supports payment");
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("tab", { name: "Scope" }).click();
  await included.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByRole("button", { name: "Add link" })).toBeDisabled();
  await expect(page.locator("#link-step option", { hasText: "Checkout / Pay" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit explanation" })).toBeVisible();
  const savedWithLink = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { traceLinks: Record<string, { explanation: string }> } } }).draft;
  expect(Object.values(savedWithLink.document.traceLinks).map((link) => link.explanation)).toEqual(["Supports payment"]);
  await page.getByLabel("Explanation", { exact: true }).first().fill("😀".repeat(4_001));
  await expect(page.getByRole("alert").filter({ hasText: "Explanation must be 4,000 characters or fewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit explanation" })).toBeDisabled();
  await page.getByLabel("Explanation", { exact: true }).first().fill("");
  await expect(page.getByRole("button", { name: "Confirm link" })).toBeDisabled();
  await page.getByRole("button", { name: "Edit explanation" }).click();
  await expect(page.getByText("Edit explanation: saved.")).toBeVisible();
  await expect(page.getByLabel("Explanation", { exact: true }).first()).toHaveValue("");
  const clearedLink = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { traceLinks: Record<string, { explanation: string }> } } }).draft;
  expect(Object.values(clearedLink.document.traceLinks).map((link) => link.explanation)).toEqual([""]);
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm requirement" }).click();
  await expect(page.getByText("Confirmed for this wording")).toBeVisible();
  await page.locator(".studio-toolbar").getByRole("button", { name: "Canvas", exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${nodeId}"] .step-label`).dblclick();
  const name = page.getByRole("textbox", { name: "Step name", exact: true });
  await name.fill("Pay now");
  await name.press("Enter");
  await saveStudio(page);
  await expect(page.getByText("Needs review: step changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed for this wording", { exact: true })).toBeVisible();
});

test("citation reads can be retried and deleted requirements keep local text for copying", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Requirement read recovery project");
  await openSpecs(page, projectId, "Requirement read recovery project");
  await page.getByLabel("Source title").fill("Recovery brief");
  await page.getByLabel("Source text").fill("Keep this evidence.");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByLabel("Source title").fill("Second recovery brief");
  await page.getByLabel("Source text").fill("Second evidence.");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("button", { name: /Recovery brief/ })).toBeVisible();
  const sources = (await (await page.request.get(`/api/projects/${projectId}/sources`)).json() as { items: Array<{ title: string; currentVersionId: string }> }).items;
  const source = sources.find((item) => item.title === "Recovery brief")!, secondSource = sources.find((item) => item.title === "Second recovery brief")!;
  let inputReads = 0, holdCitationReads = false;
  const citationCalls = new Map<string, number>(), held = new Map<string, Array<{ release: () => void; settled: Promise<void> }>>();
  await page.route(`**/api/projects/${projectId}/source-versions/*`, async (route) => {
    const sourceVersionId = route.request().url().split("/").at(-1)!;
    if (!holdCitationReads) {
      if (sourceVersionId === source.currentVersionId && inputReads++ === 0) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Source text temporarily unavailable." } }) });
      return route.continue();
    }
    if (sourceVersionId !== source.currentVersionId && sourceVersionId !== secondSource.currentVersionId) return route.continue();
    citationCalls.set(sourceVersionId, (citationCalls.get(sourceVersionId) ?? 0) + 1);
    let release!: () => void;
    const heldRead = { release: () => release(), settled: requestSettled(page, route.request()) };
    const reads = held.get(sourceVersionId) ?? []; reads.push(heldRead); held.set(sourceVersionId, reads);
    await new Promise<void>((resolve) => { release = resolve; });
    if (sourceVersionId === secondSource.currentVersionId && citationCalls.get(sourceVersionId) === 1) return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Second citation temporarily unavailable." } } });
    return route.continue();
  });
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Recover local text");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("button", { name: /REQ-001 Recover local text/ }).click();
  await page.getByLabel("Cite source").selectOption(source.currentVersionId);
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await expect(page.getByRole("button", { name: "Retry source text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add citation" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry source text" }).click();
  await expect(page.getByLabel("Excerpt")).toHaveValue("Keep this evidence.");
  await page.getByRole("button", { name: "Add citation" }).click();
  await expect(page.getByRole("button", { name: /Recovery brief v1, lines 1-1/ })).toBeVisible();
  await page.getByRole("button", { name: "Back to requirements" }).click();
  const initial = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; document: { requirements: Record<string, { id: string; version: number }> } } }).draft;
  const [savedRequirement] = Object.values(initial.document.requirements);
  const sourceRefs = [
    { sourceVersionId: source.currentVersionId, startLine: 1, endLine: 1, excerpt: "Keep this evidence." },
    { sourceVersionId: source.currentVersionId, startLine: 1, endLine: 1, excerpt: "Keep" },
    { sourceVersionId: secondSource.currentVersionId, startLine: 1, endLine: 1, excerpt: "Second evidence." },
  ];
  const updatedRefs = await page.request.post(`/api/projects/${projectId}/drafts/${initial.id}/commands`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: savedRequirement!.version, payload: { requirementId: savedRequirement!.id, title: "Recover multiple citations", sourceRefs } },
  });
  expect(updatedRefs.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: /REQ-001 Recover multiple citations/ })).toBeVisible();
  holdCitationReads = true;
  try {
    await page.getByRole("button", { name: /REQ-001 Recover multiple citations/ }).click();
    await expect.poll(() => citationCalls.get(source.currentVersionId)).toBe(1);
    await expect.poll(() => citationCalls.get(secondSource.currentVersionId)).toBe(1);
    const afterRefs = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; document: { requirements: Record<string, { id: string; version: number }> } } }).draft;
    const [unchangedRequirement] = Object.values(afterRefs.document.requirements);
    const unrelated = await page.request.post(`/api/projects/${projectId}/drafts/${afterRefs.id}/commands`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: unchangedRequirement!.version, payload: { requirementId: unchangedRequirement!.id, statement: "Unrelated saved statement" } },
    });
    expect(unrelated.status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Unrelated saved statement");
    await browserFrames(page);
    expect(citationCalls.get(source.currentVersionId)).toBe(1);
    expect(citationCalls.get(secondSource.currentVersionId)).toBe(1);
    held.get(source.currentVersionId)![0]!.release();
    await held.get(source.currentVersionId)![0]!.settled;
    await browserFrames(page);
    expect(citationCalls.get(secondSource.currentVersionId)).toBe(1);
    held.get(secondSource.currentVersionId)![0]!.release();
    await held.get(secondSource.currentVersionId)![0]!.settled;
    await expect(page.getByText("Second citation temporarily unavailable.")).toBeVisible();
    await page.getByRole("button", { name: "Retry citation", exact: true }).click();
    await expect.poll(() => citationCalls.get(secondSource.currentVersionId)).toBe(2);
    expect(citationCalls.get(source.currentVersionId)).toBe(1);
    const retriedCitation = held.get(secondSource.currentVersionId)!.at(-1)!;
    retriedCitation.release();
    await retriedCitation.settled;
    await expect(page.getByRole("button", { name: "Retry citation", exact: true })).toHaveCount(0);
    await browserFrames(page);
    expect(citationCalls.get(source.currentVersionId)).toBe(1);
    expect(citationCalls.get(secondSource.currentVersionId)).toBe(2);
  } finally {
    for (const reads of held.values()) for (const read of reads) read.release();
    await Promise.all([...held.values()].flat().map((read) => read.settled));
  }
  await page.getByLabel("Statement", { exact: true }).fill("Keep my unsaved statement.");
  const draft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; documentRevision: number; document: { requirements: Record<string, { id: string }> } } }).draft;
  const requirement = Object.values(draft.document.requirements)[0]!;
  const deleted = await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "DELETE_REQUIREMENT", expectedDocumentRevision: draft.documentRevision, payload: { requirementId: requirement.id, removeLinkIds: [] } },
  });
  expect(deleted.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("This requirement was removed.")).toBeVisible();
  await expect(page.getByLabel("Retained requirement edits")).toHaveValue("Statement: Keep my unsaved statement.");
  await expect(page.getByLabel("Retained requirement edits")).not.toBeEditable();
  await page.getByRole("button", { name: "Discard requirement edits" }).click();
  await expect(page.getByLabel("Retained requirement edits")).toHaveCount(0);
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test("one requirement save first saves the canvas and uses the resulting revision", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Save-first requirement project");
  const before = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { documentRevision: number } }).draft;
  await openSpecs(page, projectId, "Save-first requirement project");
  await page.getByRole("button", { name: "New flow" }).click();
  const flow = page.getByRole("dialog", { name: "New flow" });
  await flow.getByLabel("Title").fill("Checkout");
  await flow.getByRole("button", { name: "Create flow" }).click();
  await page.getByRole("button", { name: "Add step" }).click();
  const step = page.getByRole("dialog", { name: "Add step" });
  await step.getByLabel("Name").fill("Pay");
  await step.getByRole("button", { name: "Add step" }).click();
  const commands: Array<{ status: number; body: Record<string, unknown> }> = [];
  page.on("response", async (response) => {
    if (response.request().method() === "POST" && /\/drafts\/[^/]+\/commands$/.test(new URL(response.url()).pathname)) commands.push({ status: response.status(), body: response.request().postDataJSON() as Record<string, unknown> });
  });
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("  Pay by card  ");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await expect(page.getByRole("button", { name: /REQ-001 Pay by card/ })).toBeVisible();
  await expect(page.locator(".studio-status")).toContainText("All changes saved");
  await expect.poll(() => commands.length).toBe(1);
  expect(commands).toHaveLength(1);
  expect(commands[0]!.status).toBe(200);
  const saved = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { documentRevision: number; document: { flows: Record<string, unknown>; nodes: Record<string, unknown>; requirements: Record<string, { title: string }> } } }).draft;
  expect(saved.documentRevision).toBe(before.documentRevision + 3);
  expect(commands[0]!.body).toMatchObject({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: before.documentRevision + 2, payload: { title: "Pay by card" } });
  expect(Object.keys(saved.document.flows)).toHaveLength(1);
  expect(Object.keys(saved.document.nodes)).toHaveLength(1);
  expect(Object.values(saved.document.requirements).map((requirement) => requirement.title)).toEqual(["Pay by card"]);
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test("a held save-first keeps its reservation across a panel switch and replays its exact lost acknowledgement", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Requirement reservation project");
  await openSpecs(page, projectId, "Requirement reservation project");
  await page.getByRole("button", { name: "New flow" }).click();
  const flow = page.getByRole("dialog", { name: "New flow" });
  await flow.getByLabel("Title").fill("Checkout");
  await flow.getByRole("button", { name: "Create flow" }).click();
  await page.getByRole("button", { name: "Add step" }).click();
  const step = page.getByRole("dialog", { name: "Add step" });
  await step.getByLabel("Name").fill("Pay");
  await step.getByRole("button", { name: "Add step" }).click();
  let releaseCanvas: (() => void) | undefined;
  await page.route(`**/api/projects/${projectId}/drafts/*/changes`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise<void>((resolve) => { releaseCanvas = resolve; });
    await route.continue();
  });
  const commands: Array<{ key: string; body: string }> = [];
  await page.route(`**/api/projects/${projectId}/drafts/*/commands`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    commands.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() ?? "" });
    if (commands.length === 1) { await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Pay by card");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await expect.poll(() => Boolean(releaseCanvas)).toBe(true);
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("tab", { name: "Specs" }).click();
  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(page.getByRole("button", { name: "Add source" })).toBeDisabled();
  releaseCanvas!();
  await expect(page.getByText(/Retry sends the same request/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Save requirement: saved.")).toBeVisible();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  const draft = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { requirements: Record<string, unknown> } } }).draft;
  expect(Object.keys(draft.document.requirements)).toHaveLength(1);
});

test("a stale requirement edit is explicitly rebased after remount without overwriting remote fields", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Requirement edit guard project");
  await openSpecs(page, projectId, "Requirement edit guard project");
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Pay by card");
  await page.getByLabel("Statement", { exact: true }).fill("Original statement");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Other payment");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("My title");
  await page.getByLabel("Title", { exact: true }).fill("Pay by card");
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  await page.getByLabel("Title", { exact: true }).fill("My title");
  const initial = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { id: string; document: { requirements: Record<string, { id: string; displayId: string; version: number }> } } }).draft;
  const requirement = Object.values(initial.document.requirements).find((item) => item.displayId === "REQ-001")!;
  const path = `/api/projects/${projectId}/drafts/${initial.id}/commands`;
  const remote = await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement!.version, payload: { requirementId: requirement!.id, statement: "Remote statement" } },
  });
  expect(remote.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Remote statement");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My title");
  const refused = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/commands") && response.request().postDataJSON().command === "UPDATE_REQUIREMENT");
  await page.getByRole("button", { name: "Save requirement" }).click();
  const response = await refused;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toEqual({ commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement!.version, payload: { requirementId: requirement!.id, title: "My title" } });
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved this requirement first" })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My title");
  await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Remote statement");
  await page.getByRole("button", { name: "Back to requirements" }).click();
  await page.getByRole("button", { name: /REQ-002 Other payment/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Keep other payment");
  await expect(page.getByRole("button", { name: "Use saved values" })).toHaveCount(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep other payment");
  await page.getByRole("button", { name: "Back to requirements" }).click();
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved this requirement first" })).toBeVisible();
  await page.getByRole("button", { name: "Use my edits on latest version" }).click();
  const raced = await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement!.version + 1, payload: { requirementId: requirement!.id, statement: "Remote statement after rebase" } },
  });
  expect(raced.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My title");
  await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Remote statement after rebase");
  const refusedAgain = page.waitForResponse((item) => item.request().method() === "POST" && item.url().endsWith("/commands") && item.request().postDataJSON().command === "UPDATE_REQUIREMENT");
  await page.getByRole("button", { name: "Save requirement" }).click();
  const secondResponse = await refusedAgain;
  expect(secondResponse.status()).toBe(409);
  expect(secondResponse.request().postDataJSON()).toEqual({ commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement!.version + 1, payload: { requirementId: requirement!.id, title: "My title" } });
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved this requirement first" })).toBeVisible();
  await page.getByRole("button", { name: "Use my edits on latest version" }).click();
  const accepted = page.waitForResponse((item) => item.request().method() === "POST" && item.url().endsWith("/commands") && item.request().postDataJSON().command === "UPDATE_REQUIREMENT");
  await page.getByRole("button", { name: "Save requirement" }).click();
  const finalResponse = await accepted;
  expect(finalResponse.status()).toBe(200);
  expect(finalResponse.request().postDataJSON()).toEqual({ commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement!.version + 2, payload: { requirementId: requirement!.id, title: "My title" } });
  const final = (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: { document: { requirements: Record<string, { statement: string; title: string }> } } }).draft;
  expect(Object.keys(final.document.requirements)).toHaveLength(2);
  expect(final.document.requirements[requirement.id]).toMatchObject({ title: "My title", statement: "Remote statement after rebase" });
  expect(Object.values(final.document.requirements).find((item) => item.title === "Other payment")).toMatchObject({ statement: "" });
});

test("trace explanation conflicts offer explicit reconciliation and removed links retain copyable input", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Trace recovery project"), flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  await openSpecs(page, projectId, "Trace recovery project");
  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Payment");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("button", { name: /REQ-001 Payment/ }).click();
  await page.getByLabel("Link to step").selectOption(nodeId);
  await page.locator("#link-explanation").fill("😀".repeat(4_001));
  await expect(page.getByRole("button", { name: "Add link" })).toBeDisabled();
  await page.locator("#link-explanation").fill("Original explanation");
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByRole("button", { name: "Edit explanation" })).toBeVisible();
  await page.getByRole("button", { name: "Back to requirements" }).click();
  await page.getByRole("button", { name: "New requirement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Other payment");
  await page.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("button", { name: /REQ-001 Payment/ }).click();
  const readDraft = async () => (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json()).draft as { id: string; documentRevision: number; document: { traceLinks: Record<string, { id: string; version: number; explanation: string }> } };
  const initial = await readDraft(), original = Object.values(initial.document.traceLinks)[0]!;
  const path = `/api/projects/${projectId}/drafts/${initial.id}/commands`, explanation = page.locator(`#link-${original.id}`);
  await explanation.fill("My explanation");
  const remote = await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_TRACE_LINK", expectedEntityVersion: original.version, payload: { linkId: original.id, explanation: "Remote explanation" } },
  });
  expect(remote.status()).toBe(200);
  const refused = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(path) && response.request().postDataJSON().command === "UPDATE_TRACE_LINK");
  await page.getByRole("button", { name: "Edit explanation" }).click();
  const conflict = await refused;
  expect(conflict.status()).toBe(409);
  expect(conflict.request().postDataJSON().expectedEntityVersion).toBe(original.version);
  await expect(page.getByLabel("Current saved explanation")).toHaveValue("Remote explanation");
  await page.getByRole("button", { name: "Back to requirements" }).click();
  await page.getByRole("button", { name: /REQ-002 Other payment/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Keep other payment");
  await expect(page.getByRole("button", { name: "Use saved values" })).toHaveCount(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep other payment");
  await page.getByLabel("Title", { exact: true }).fill("Other payment");
  await page.getByRole("button", { name: "Back to requirements" }).click();
  await switchTabs(page);
  await page.getByRole("button", { name: /REQ-001 Payment/ }).click();
  await expect(explanation).toHaveValue("My explanation");
  await expect(page.getByLabel("Current saved explanation")).toHaveValue("Remote explanation");
  await page.getByRole("button", { name: "Use my explanation on latest version" }).click();
  const accepted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(path) && response.request().postDataJSON().command === "UPDATE_TRACE_LINK");
  await page.getByRole("button", { name: "Edit explanation" }).click();
  const saved = await accepted;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toMatchObject({ expectedEntityVersion: original.version + 1, payload: { explanation: "My explanation" } });
  await expect(page.getByText("Edit explanation: saved.")).toBeVisible();
  expect((await readDraft()).document.traceLinks[original.id]!.explanation).toBe("My explanation");
  await explanation.fill("Discard this explanation");
  const beforeDiscard = await readDraft();
  const changed = await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "UPDATE_TRACE_LINK", expectedEntityVersion: beforeDiscard.document.traceLinks[original.id]!.version, payload: { linkId: original.id, explanation: "Newest saved explanation" } },
  });
  expect(changed.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Current saved explanation")).toHaveValue("Newest saved explanation");
  await page.getByRole("button", { name: "Use saved explanation" }).click();
  await expect(explanation).toHaveValue("Newest saved explanation");
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  await explanation.fill("Keep for copying");
  const beforeDelete = await readDraft();
  const removed = await page.request.post(path, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { commandSchemaVersion: 1, command: "DELETE_TRACE_LINK", expectedDocumentRevision: beforeDelete.documentRevision, payload: { linkId: original.id } },
  });
  expect(removed.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Retained explanation for removed link")).toHaveValue("Keep for copying");
  await expect(page.getByLabel("Retained explanation for removed link")).not.toBeEditable();
  await page.getByRole("button", { name: "Discard removed link edits" }).click();
  await expect(page.getByLabel("Retained explanation for removed link")).toHaveCount(0);
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

collaborationTest("a reviewer reads sources and requirements without edit controls", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, setEditorRole } = collaboration;
  const name: string = (await (await ownerPage.request.get(`/api/projects/${projectId}/bootstrap`)).json()).project.name;
  await test.step("owner creates the source and requirement", async () => {
    await openSpecs(ownerPage, projectId, name);
    await ownerPage.getByLabel("Source title").fill("Brief");
    await ownerPage.getByLabel("Source text").fill("Shared text");
    await ownerPage.getByRole("button", { name: "Add source" }).click();
    await expect(ownerPage.getByRole("button", { name: /Brief/ })).toBeVisible();
    await ownerPage.getByRole("tab", { name: "Scope" }).click();
    await ownerPage.getByRole("button", { name: "New requirement" }).click();
    await ownerPage.getByLabel("Title", { exact: true }).fill("Pay by card");
    await ownerPage.getByRole("button", { name: "Save requirement" }).click();
  });
  await setEditorRole("REVIEWER");
  await openSpecs(editorPage, projectId, name);
  await test.step("reviewer reads the source without source write controls", async () => {
    await expect(editorPage.getByRole("button", { name: /Brief/ })).toBeVisible();
    await expect(editorPage.getByLabel("Source text")).toHaveCount(0);
    await editorPage.getByRole("button", { name: /Brief/ }).click();
    await expect(editorPage.locator(".source-lines li")).toHaveText(["Shared text"]);
    await expect(editorPage.getByRole("button", { name: "Save new version" })).toHaveCount(0);
    await expect(editorPage.getByLabel("Corrected text")).toHaveCount(0);
    await expect(editorPage.getByRole("button", { name: "Archive" })).toHaveCount(0);
  });
  await test.step("reviewer reads the requirement without requirement write controls", async () => {
    await editorPage.getByRole("tab", { name: "Scope" }).click();
    await expect(editorPage.getByRole("button", { name: /REQ-001 Pay by card/ })).toBeVisible({ timeout: 20_000 });
    await expect(editorPage.getByRole("button", { name: "New requirement" })).toHaveCount(0);
    await editorPage.getByRole("button", { name: /REQ-001 Pay by card/ }).click();
    await expect(editorPage.getByLabel("Title", { exact: true })).not.toBeEditable();
    await expect(editorPage.getByLabel("Statement", { exact: true })).not.toBeEditable();
    await expect(editorPage.getByRole("button", { name: "Save requirement" })).toHaveCount(0);
    await expect(editorPage.getByRole("button", { name: "Confirm requirement" })).toHaveCount(0);
    await expect(editorPage.getByRole("button", { name: "Add citation" })).toHaveCount(0);
    await expect(editorPage.getByRole("button", { name: "Add link" })).toHaveCount(0);
  });
});
